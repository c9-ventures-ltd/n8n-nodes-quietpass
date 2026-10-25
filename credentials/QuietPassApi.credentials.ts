import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class QuietPassApi implements ICredentialType {
	name = 'quietPassApi';
	displayName = 'QuietPass API';
	documentationUrl = 'https://github.com/c9-ventures-ltd/n8n-nodes-quietpass#credentials';
	icon = 'file:quietpass.svg' as const;
	properties: INodeProperties[] = [
		{
			displayName: 'Server API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create a server API key in your QuietPass console. Never put it in workflow data.',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://quietpass.com',
			url: '/v1/wallet',
			method: 'GET',
			disableFollowRedirect: true,
		},
	};
}
