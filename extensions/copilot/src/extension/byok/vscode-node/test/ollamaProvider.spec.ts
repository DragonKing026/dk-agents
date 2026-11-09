/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { OllamaLMProvider } from '../ollamaProvider';

function createProvider(fetch: (url: string, options: { body?: string }) => Promise<unknown>): OllamaLMProvider {
	const logService = {
		_serviceBrand: undefined,
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		show: vi.fn(),
		createSubLogger: vi.fn(),
		withExtraTarget: vi.fn(),
	};
	logService.createSubLogger.mockReturnValue(logService);
	logService.withExtraTarget.mockReturnValue(logService);

	return new OllamaLMProvider(
		{
			getAPIKey: vi.fn().mockResolvedValue(undefined),
			storeAPIKey: vi.fn().mockResolvedValue(undefined),
			deleteAPIKey: vi.fn().mockResolvedValue(undefined),
			getStoredModelConfigs: vi.fn().mockResolvedValue({}),
			saveModelConfig: vi.fn().mockResolvedValue(undefined),
			removeModelConfig: vi.fn().mockResolvedValue(undefined),
		} as any,
		{ fetch } as any,
		{
			isConfigured: vi.fn().mockReturnValue(false),
			getConfig: vi.fn(),
			setConfig: vi.fn(),
		} as any,
		logService as any,
		{
			createInstance: vi.fn().mockReturnValue({}),
		} as any,
		{} as any
	);
}

describe('OllamaLMProvider', () => {
	it('returns successful models when one /api/show lookup fails', async () => {
		const ollamaBaseUrl = 'http://localhost:11434';
		const tagsModels = [{ model: 'good-model-a' }, { model: 'bad-model' }, { model: 'good-model-b' }];
		const showCalls: string[] = [];

		const fetch = vi.fn(async (url: string, options: { body?: string }) => {
			if (url === `${ollamaBaseUrl}/api/version`) {
				return { json: async () => ({ version: '0.6.4' }) };
			}
			if (url === `${ollamaBaseUrl}/api/tags`) {
				return { json: async () => ({ models: tagsModels }) };
			}
			if (url === `${ollamaBaseUrl}/api/show`) {
				const modelId = JSON.parse(options.body ?? '{}').model as string;
				showCalls.push(modelId);
				if (modelId === 'bad-model') {
					throw new Error('simulated /api/show failure');
				}
				return {
					json: async () => ({
						template: '',
						capabilities: [],
						details: { family: 'llama' },
						remote_model: modelId,
						model_info: {
							'general.basename': modelId,
							'general.architecture': 'llama',
							'llama.context_length': 8192,
						},
					})
				};
			}
			throw new Error(`Unexpected URL in test: ${url}`);
		});

		const provider = createProvider(fetch);

		const tokenSource = new vscode.CancellationTokenSource();
		const models = await provider.provideLanguageModelChatInformation(
			{
				silent: false,
				configuration: { url: ollamaBaseUrl },
			},
			tokenSource.token
		);

		expect(showCalls).toEqual(['good-model-a', 'bad-model', 'good-model-b']);
		expect(models.map(model => model.id)).toEqual(['good-model-a', 'good-model-b']);
	});

	it('marks cloud models, which Ollama forwards to a remote host, in the model name', async () => {
		const ollamaBaseUrl = 'http://localhost:11434';
		const fetch = vi.fn(async (url: string, options: { body?: string }) => {
			if (url === `${ollamaBaseUrl}/api/version`) {
				return { json: async () => ({ version: '0.40.11' }) };
			}
			if (url === `${ollamaBaseUrl}/api/tags`) {
				return { json: async () => ({ models: [{ model: 'local-model' }, { model: 'big-model:cloud', remote_host: 'https://ollama.com' }] }) };
			}
			if (url === `${ollamaBaseUrl}/api/show`) {
				const modelId = JSON.parse(options.body ?? '{}').model as string;
				return { json: async () => ({ template: '', capabilities: ['completion', 'tools'], details: { family: 'llama' }, model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 }, remote_model: modelId }) };
			}
			throw new Error(`Unexpected URL in test: ${url}`);
		});

		const models = await createProvider(fetch).provideLanguageModelChatInformation({ silent: false, configuration: { url: ollamaBaseUrl } }, new vscode.CancellationTokenSource().token);

		expect(models.map(model => [model.id, model.name])).toEqual([['local-model', 'local-model'], ['big-model:cloud', 'big-model:cloud (cloud)']]);
	});
});
