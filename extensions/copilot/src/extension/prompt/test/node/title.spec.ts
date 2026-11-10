/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { IRequestLogger } from '../../../../platform/requestLogger/common/requestLogger';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn } from '../../../../vscodeTypes';
import { ChatTitleProvider, findModelByIdentifier } from '../../node/title';

vi.mock('../../../prompts/node/base/promptRenderer', () => ({
	renderPromptElement: vi.fn(async () => ({ messages: [] })),
}));

function model(vendor: string, id: string): vscode.LanguageModelChat {
	return { vendor, id, family: id, name: id, version: '1', maxInputTokens: 1 } as unknown as vscode.LanguageModelChat;
}

function turn(modelId: string | undefined): ChatRequestTurn {
	// The test shim keeps the two turn classes apart; in the extension host they are one class carrying `modelId`.
	return Object.assign(new (ChatRequestTurn as unknown as new (...args: unknown[]) => ChatRequestTurn)('hello', undefined, [], 'p', []), { modelId });
}

describe('findModelByIdentifier', () => {
	const ollama = model('ollama', 'gpt-oss:20b');
	const other = model('ollama', 'other');
	const models = [other, ollama, model('copilot', 'gpt-oss:20b')];

	it('matches vendor/id and vendor/group/id, and never guesses', () => {
		expect([
			findModelByIdentifier(models, 'ollama/gpt-oss:20b'),
			findModelByIdentifier(models, 'ollama/local/gpt-oss:20b'),
			findModelByIdentifier(models, 'ollama/missing'),
			findModelByIdentifier(models, 'nomodel'),
			findModelByIdentifier(models, 'azure/gpt-oss:20b'),
		]).toEqual([ollama, ollama, undefined, undefined, undefined]);
	});
});

describe('ChatTitleProvider', () => {
	const calls: unknown[] = [];
	let endpointProvider: IEndpointProvider;
	let provider: (resolve: ((id: string) => Promise<vscode.LanguageModelChat | undefined>) | undefined) => ChatTitleProvider;
	const token = { isCancellationRequested: false } as vscode.CancellationToken;
	const byok = model('ollama', 'gpt-oss:20b');

	beforeEach(() => {
		calls.length = 0;
		endpointProvider = {
			getChatEndpoint: async (arg: unknown) => {
				calls.push(arg);
				return { makeChatRequest2: async () => ({ type: ChatFetchResponseType.Success, value: ' "A title" ' }) };
			},
		} as unknown as IEndpointProvider;
		const logService = { warn() { }, error() { } } as unknown as ILogService;
		const requestLogger = { captureInvocation: (_t: unknown, fn: () => Promise<unknown>) => fn() } as unknown as IRequestLogger;
		provider = resolve => new ChatTitleProvider(resolve, logService, endpointProvider, {} as IInstantiationService, requestLogger);
	});

	const context = (modelId: string | undefined) => ({ history: [turn(modelId)] }) as unknown as vscode.ChatContext;

	it('registers the request model before asking for the utility endpoint', async () => {
		const title = await provider(async id => id === 'ollama/gpt-oss:20b' ? byok : undefined).provideChatTitle(context('ollama/gpt-oss:20b'), token);
		expect({ title, calls }).toEqual({ title: 'A title', calls: [byok, 'copilot-utility-small'] });
	});

	it('only asks for the utility endpoint without a model id', async () => {
		const resolve = vi.fn(async () => byok);
		await provider(resolve).provideChatTitle(context(undefined), token);
		expect({ calls, resolved: resolve.mock.calls.length }).toEqual({ calls: ['copilot-utility-small'], resolved: 0 });
	});

	it('ignores an unknown model id and a failing resolver', async () => {
		const unknown = await provider(async () => undefined).provideChatTitle(context('ollama/missing'), token);
		const failing = await provider(async () => { throw new Error('boom'); }).provideChatTitle(context('ollama/x'), token);
		expect({ unknown, failing, calls }).toEqual({ unknown: 'A title', failing: 'A title', calls: ['copilot-utility-small', 'copilot-utility-small'] });
	});
});
