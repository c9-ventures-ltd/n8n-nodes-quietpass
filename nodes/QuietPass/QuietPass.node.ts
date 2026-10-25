import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeApiError, NodeOperationError } from 'n8n-workflow';
import {
	acceptedQuote,
	api,
	eventKey,
	fail,
	maximumMicros,
	object,
	originalOperation,
	phoneInput,
	QuietPassFailure,
	safeFailure,
	selectedChecks,
	settlement,
	validQuoteId,
	workspaceCurrency,
} from './Helpers';
import type { Operation } from './Helpers';
import { properties } from './Properties';

interface Prepared {
	body?: IDataObject;
	maximum?: number;
	currency?: string;
	requestKey?: string;
	operation?: Operation;
	quoteId?: string;
	details: string;
}

export class QuietPass implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'QuietPass',
		name: 'quietPass',
		icon: { light: 'file:quietpass.svg', dark: 'file:quietpass.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Check phone numbers, carriers, network status, and messaging accounts with spending controls',
		defaults: { name: 'QuietPass' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'quietPassApi', required: true }],
		usableAsTool: true,
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		if (!items.length) return [[]];
		const mode = this.getNodeParameter('operation', 0) as string;
		const options = object(this.getNodeParameter('options', 0, {}));
		const itemLimit = options.maximumItems ?? 25;
		if (
			!Number.isSafeInteger(itemLimit) ||
			Number(itemLimit) < 1 ||
			Number(itemLimit) > 1000 ||
			items.length > Number(itemLimit)
		) {
			throw new NodeOperationError(
				this.getNode(),
				'The input batch exceeds Maximum Input Items. No request was started.',
			);
		}
		if (!['check', 'format', 'quote', 'execute', 'getResult'].includes(mode))
			throw new NodeOperationError(this.getNode(), 'Choose a supported operation.');
		if (mode === 'check' && this.getNode().retryOnFail) {
			throw new NodeOperationError(
				this.getNode(),
				'Turn off Retry On Fail for Check Phone Number. Use the original quote with Get Lookup Result or Submit Original Quote for recovery.',
			);
		}

		// Validate the whole batch and its worst-case spend before any request.
		const prepared: Array<Prepared | QuietPassFailure> = [];
		const keys = new Set<string>();
		let total = 0;
		let batchCurrency = '';
		for (let i = 0; i < items.length; i++) {
			try {
				const detailOptions = object(this.getNodeParameter('options', i, {}));
				const p: Prepared = {
					details: detailOptions.includeDetails === true ? '?include_details=true' : '',
				};
				if (['format', 'check', 'quote'].includes(mode))
					p.body = phoneInput(
						this.getNodeParameter('phone', i),
						this.getNodeParameter('defaultCountry', i, ''),
					);
				if (['check', 'quote'].includes(mode)) {
					p.body = { ...p.body, checks: selectedChecks(this.getNodeParameter('checks', i)) };
					p.maximum = maximumMicros(this.getNodeParameter('maximumPrice', i));
					p.currency = workspaceCurrency(this.getNodeParameter('currency', i));
					p.requestKey = eventKey(this.getNodeParameter('sourceEventId', i));
					if (keys.has(p.requestKey))
						fail(
							'DUPLICATE_EVENT',
							'Two input items share a source event ID. No batch request was started.',
						);
					keys.add(p.requestKey);
				}
				if (mode === 'execute') {
					p.operation = originalOperation({
						quoteId: this.getNodeParameter('quoteId', i),
						maxSpendMicros: this.getNodeParameter('maxSpendMicros', i),
						requestKey: this.getNodeParameter('requestKey', i),
						currency: this.getNodeParameter('currency', i),
					});
					p.currency = p.operation.currency;
					p.maximum = p.operation.maxSpendMicros;
				}
				if (mode === 'getResult') p.quoteId = validQuoteId(this.getNodeParameter('quoteId', i));
				if (['check', 'execute'].includes(mode)) {
					if (this.getNodeParameter('allowLive', i, false) !== true)
						fail(
							'LIVE_LOOKUP_OFF',
							'Enable Allow Live Lookup only after reviewing the selected checks and spending limits. Manual executions also use live credit.',
						);
					if (batchCurrency && batchCurrency !== p.currency)
						fail('MIXED_CURRENCY', 'All input items must use the same workspace currency.');
					batchCurrency = p.currency!;
					total += p.maximum!;
				}
				prepared.push(p);
			} catch (error) {
				const failure = safeFailure(error);
				// Invalid batch inputs must never leave an earlier item already charged.
				if (
					!this.continueOnFail() ||
					['DUPLICATE_EVENT', 'MIXED_CURRENCY'].includes(failure.code)
				) {
					throw new NodeOperationError(this.getNode(), failure.message, { itemIndex: i });
				}
				prepared.push(failure);
			}
		}
		if (['check', 'execute'].includes(mode)) {
			let maximumTotal: number;
			try {
				maximumTotal = maximumMicros(this.getNodeParameter('maximumTotalPrice', 0, '1.00'));
			} catch (error) {
				throw new NodeOperationError(this.getNode(), safeFailure(error).message);
			}
			if (total > maximumTotal)
				throw new NodeOperationError(
					this.getNode(),
					'The batch exceeds Maximum Total Price per Run. Split the input or deliberately raise the cap. No request was started.',
				);
		}

		const output: INodeExecutionData[] = [];
		for (let i = 0; i < prepared.length; i++) {
			let operation: Operation | undefined;
			try {
				const p = prepared[i];
				if (p instanceof QuietPassFailure) throw p;
				let result: IDataObject;
				if (mode === 'format') {
					result = await api(this, '/v1/phone/check' + p.details, {
						...p.body,
						checks: ['basic_line_type'],
					});
				} else if (mode === 'getResult') {
					const response = await api(this, '/v1/phone/results/' + p.quoteId + p.details);
					if (response.state !== 'settled' || !Object.keys(object(response.result)).length) {
						const state = ['pending', 'not_started', 'expired'].includes(String(response.state))
							? String(response.state)
							: 'unknown';
						fail(
							'RESULT_' + state.toUpperCase(),
							`The original lookup is ${state}. No new lookup was run. Do not treat this as a negative contact result.`,
							undefined,
							409,
						);
					}
					result = {
						...object(response.result),
						operation: { quoteId: p.quoteId!, state: 'settled' },
					};
				} else {
					if (mode === 'execute') {
						operation = p.operation!;
					} else {
						const quote = await api(this, '/v1/phone/quote', p.body);
						operation = acceptedQuote(quote, p.maximum!, p.currency!, p.requestKey!);
						if (mode === 'quote') {
							output.push({ json: { ...quote, operation }, pairedItem: { item: i } });
							continue;
						}
					}
					result = settlement(
						await api(
							this,
							'/v1/phone/execute' + p.details,
							{ quoteId: operation.quoteId, maxSpendMicros: operation.maxSpendMicros },
							operation,
						),
						operation,
					);
				}
				output.push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				const failure = safeFailure(error);
				operation = failure.operation ?? operation;
				const description = operation
					? `${failure.message} Original operation: ${JSON.stringify(operation)}. Use Get Lookup Result first. Submit Original Quote reuses these exact references; it never requotes.`
					: failure.message;
				if (this.continueOnFail()) {
					output.push({
						json: {
							error: { code: failure.code, message: failure.message },
							...(operation ? { operation } : {}),
						},
						pairedItem: { item: i },
					});
					continue;
				}
				if (failure.httpStatus)
					throw new NodeApiError(
						this.getNode(),
						{ message: failure.message },
						{
							message: failure.message,
							description,
							httpCode: String(failure.httpStatus),
							itemIndex: i,
						},
					);
				throw new NodeOperationError(this.getNode(), failure.message, {
					description,
					itemIndex: i,
				});
			}
		}
		return [output];
	}
}
