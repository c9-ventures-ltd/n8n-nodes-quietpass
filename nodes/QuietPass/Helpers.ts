import { createHash } from 'node:crypto';
import type { IDataObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';

export const checks = [
	'basic_line_type',
	'enhanced_line_type',
	'current_carrier',
	'mnp',
	'live_status',
	'sms',
	'whatsapp',
	'telegram',
];
export const currencies = ['GBP', 'USD', 'EUR'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface Operation extends IDataObject {
	quoteId: string;
	maxSpendMicros: number;
	requestKey: string;
	currency: string;
}

export class QuietPassFailure extends Error {
	constructor(
		public code: string,
		message: string,
		public operation?: Operation,
		public httpStatus?: number,
	) {
		super(message);
	}
}

// Internal failures carry only sanitized data; execute() converts them to n8n UI errors.
export function fail(
	code: string,
	message: string,
	operation?: Operation,
	httpStatus?: number,
): never {
	throw new QuietPassFailure(code, message, operation, httpStatus);
}

export function object(value: unknown): IDataObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: {};
}

export function maximumMicros(value: unknown): number {
	const text = String(value ?? '');
	if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(text)) {
		throw new QuietPassFailure(
			'INVALID_MAXIMUM',
			'Use a maximum price between 0 and 100 with at most six decimal places.',
		);
	}
	const [whole, fraction = ''] = text.split('.');
	const maximum = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
	if (maximum > 100_000_000)
		throw new QuietPassFailure(
			'INVALID_MAXIMUM',
			'The maximum price cannot exceed 100 in the workspace currency.',
		);
	return maximum;
}

export function phoneInput(phoneValue: unknown, countryValue: unknown): IDataObject {
	if (typeof phoneValue !== 'string' || !phoneValue.trim() || phoneValue.length > 250) {
		throw new QuietPassFailure(
			'INVALID_PHONE',
			'Map one phone number as text. National numbers also need a two-letter country code.',
		);
	}
	const phone = phoneValue.trim();
	const country = String(countryValue ?? '')
		.trim()
		.toUpperCase();
	if (country && !/^[A-Z]{2}$/.test(country))
		throw new QuietPassFailure(
			'INVALID_COUNTRY',
			'Use a two-letter country code, such as GB or US.',
		);
	if (!/^(?:\+|00)/.test(phone) && !country)
		throw new QuietPassFailure(
			'COUNTRY_REQUIRED',
			'Map a country for this national-format number, or supply an international number starting with + or 00.',
		);
	return { phone, ...(country ? { default_country: country } : {}) };
}

export function selectedChecks(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		!value.length ||
		value.length > checks.length ||
		new Set(value).size !== value.length ||
		value.some((v) => typeof v !== 'string' || !checks.includes(v))
	) {
		throw new QuietPassFailure(
			'INVALID_CHECKS',
			'Select at least one supported check without duplicates.',
		);
	}
	return value as string[];
}

export function eventKey(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > 500 ||
		/REPLACE_WITH|\{\{/.test(value)
	) {
		throw new QuietPassFailure(
			'EVENT_ID_REQUIRED',
			'Map a stable event ID, namespaced by source and workflow. Reuse it on retry. Do not use a phone number, current time, or execution ID.',
		);
	}
	return 'qp_n8n_' + createHash('sha256').update(value.trim()).digest('hex');
}

export function validQuoteId(value: unknown): string {
	if (typeof value !== 'string' || !uuid.test(value))
		throw new QuietPassFailure(
			'INVALID_QUOTE_ID',
			'Use the original Quote ID from the lookup or quote output.',
		);
	return value;
}

export function workspaceCurrency(value: unknown): string {
	if (typeof value !== 'string' || !currencies.includes(value))
		throw new QuietPassFailure(
			'INVALID_CURRENCY',
			'Choose your workspace currency: GBP, USD, or EUR.',
		);
	return value;
}

export function originalOperation(value: IDataObject): Operation {
	const quoteId = validQuoteId(value.quoteId);
	const maximum = value.maxSpendMicros;
	if (
		typeof maximum !== 'number' ||
		!Number.isSafeInteger(maximum) ||
		maximum < 0 ||
		maximum > 100_000_000
	) {
		throw new QuietPassFailure(
			'INVALID_MAXIMUM',
			'Map the original integer Maximum Spend Micros from the quote output.',
		);
	}
	if (typeof value.requestKey !== 'string' || !/^qp_n8n_[a-f0-9]{64}$/.test(value.requestKey)) {
		throw new QuietPassFailure(
			'INVALID_REQUEST_KEY',
			'Map the original Request Key from a live QuietPass n8n quote.',
		);
	}
	return {
		quoteId,
		maxSpendMicros: maximum,
		requestKey: value.requestKey,
		currency: workspaceCurrency(value.currency),
	};
}

export async function api(
	context: IExecuteFunctions,
	path: string,
	body?: IDataObject,
	operation?: Operation,
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		url: 'https://quietpass.com' + path,
		method: body ? 'POST' : 'GET',
		headers: {
			Accept: 'application/json',
			...(operation ? { 'Idempotency-Key': operation.requestKey } : {}),
		},
		...(body ? { body } : {}),
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		disableFollowRedirect: true,
		timeout: 20_000,
	};
	let response: IDataObject;
	try {
		response = object(
			await context.helpers.httpRequestWithAuthentication.call(context, 'quietPassApi', options),
		);
	} catch {
		// Never attach transport errors: they may contain credentials and request bodies.
		const failure = new QuietPassFailure(
			'CONNECTION_UNCERTAIN',
			operation
				? 'No response was received. Retrieve the original lookup result before retrying. No replacement quote was created.'
				: 'No response was received. No paid lookup was executed by this request.',
			operation,
			503,
		);
		throw failure;
	}
	const status = Number(response.statusCode);
	const data = object(response.body);
	if (status < 200 || status >= 300 || !Number.isInteger(status)) {
		const error = object(data.error);
		const code =
			typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
				? error.code
				: 'API_ERROR';
		const reference =
			typeof error.requestId === 'string' && uuid.test(error.requestId)
				? ` Reference: ${error.requestId}.`
				: '';
		throw new QuietPassFailure(
			code,
			`QuietPass returned ${code}.${reference}${operation ? ' Keep the original operation for recovery; do not start a replacement lookup.' : ''}`,
			operation,
			status,
		);
	}
	if (!Object.keys(data).length)
		throw new QuietPassFailure(
			'INVALID_RESPONSE',
			'QuietPass returned an unreadable response.',
			operation,
			502,
		);
	return data;
}

export function acceptedQuote(
	response: IDataObject,
	maximum: number,
	currency: string,
	requestKey: string,
): Operation {
	const quote = object(response.quote);
	if (
		typeof quote.id !== 'string' ||
		!uuid.test(quote.id) ||
		quote.currency !== currency ||
		typeof quote.maxMicros !== 'number' ||
		!Number.isSafeInteger(quote.maxMicros) ||
		quote.maxMicros < 0 ||
		quote.maxMicros > maximum ||
		typeof quote.expiresAt !== 'string' ||
		!Number.isFinite(Date.parse(quote.expiresAt)) ||
		Date.parse(quote.expiresAt) <= Date.now()
	) {
		throw new QuietPassFailure(
			'QUOTE_NOT_ACCEPTED',
			'The quote exceeded your cap, changed currency, or expired. Nothing was executed.',
		);
	}
	return { quoteId: quote.id, maxSpendMicros: quote.maxMicros, requestKey, currency };
}

export function settlement(result: IDataObject, operation: Operation): IDataObject {
	const billing = object(result.billing);
	if (
		!Object.keys(object(result.number)).length ||
		billing.currency !== operation.currency ||
		typeof billing.chargedMicros !== 'number' ||
		!Number.isSafeInteger(billing.chargedMicros) ||
		billing.chargedMicros < 0 ||
		billing.chargedMicros > operation.maxSpendMicros
	) {
		throw new QuietPassFailure(
			'INVALID_SETTLEMENT',
			'The settlement could not be verified. Retrieve the original result before starting another lookup.',
			operation,
			502,
		);
	}
	return { ...result, operation };
}

export function safeFailure(value: unknown): QuietPassFailure {
	return value instanceof QuietPassFailure
		? value
		: new QuietPassFailure(
				'NODE_ERROR',
				'The node could not complete this item. Keep any original operation references; do not rerun a paid check blindly.',
			);
}
