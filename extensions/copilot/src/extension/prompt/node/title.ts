/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { sessionResourceToId } from '../../../platform/chat/common/chatDebugFileLoggerService';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn } from '../../../vscodeTypes';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { TitlePrompt } from '../../prompts/node/panel/title';

/**
 * Resolves the identifier a chat request turn carries in `modelId` (`vendor/id` or
 * `vendor/group/id`) to the language model it names, or `undefined` when none matches.
 */
export type ResolveLanguageModel = (modelIdentifier: string) => Promise<vscode.LanguageModelChat | undefined>;

export class ChatTitleProvider implements vscode.ChatTitleProvider {

	constructor(
		private readonly resolveLanguageModel: ResolveLanguageModel | undefined,
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
	) { }

	/**
	 * The title is generated while the first request is still starting, so the endpoint provider
	 * may not know the BYOK model of that request yet. Without it the utility endpoint falls back
	 * to a Copilot model and fails without a Copilot account. Passing the model to the provider
	 * records it exactly like the main request does, which keeps the utility model settings working.
	 */
	private async registerRequestModel(modelIdentifier: string | undefined): Promise<void> {
		// A Copilot model resolves to the utility models anyway; registering it
		// would only cost a model fetch.
		if (!modelIdentifier || !this.resolveLanguageModel || modelIdentifier.startsWith('copilot/')) {
			return;
		}
		try {
			const model = await this.resolveLanguageModel(modelIdentifier);
			if (model) {
				await this.endpointProvider.getChatEndpoint(model);
			}
		} catch (error) {
			this.logService.warn(`Could not resolve model '${modelIdentifier}' for the conversation title: ${error}`);
		}
	}

	async provideChatTitle(
		context: vscode.ChatContext,
		token: vscode.CancellationToken,
	): Promise<string | undefined> {

		// Get the first user message directly from the context
		// Use instanceof to properly check if the first item is a ChatRequestTurn
		const firstRequest = context.history.find(item => item instanceof ChatRequestTurn);
		if (!firstRequest) {
			return '';
		}

		// Extract the parent session ID from the context's sessionResource (provided by VS Code)
		const sessionResource = context.sessionResource;
		const parentChatSessionId = sessionResource ? sessionResourceToId(URI.from(sessionResource)) : undefined;

		// `ChatRequestTurn` and `ChatRequestTurn2` are the same class in the extension host; only `ChatRequestTurn2` declares `modelId`.
		await this.registerRequestModel((firstRequest as vscode.ChatRequestTurn2).modelId);
		const endpoint = await this.endpointProvider.getChatEndpoint('copilot-utility-small');
		const { messages } = await renderPromptElement(this.instantiationService, endpoint, TitlePrompt, { userRequest: firstRequest.prompt });

		const capturingToken = new CapturingToken(
			'title',
			undefined,
			undefined,
			undefined,
			undefined,
			parentChatSessionId,
			'title',
		);

		const doRequest = async () => {
			const response = await endpoint.makeChatRequest2({
				debugName: 'title',
				messages,
				finishedCb: undefined,
				location: ChatLocation.Panel,
				userInitiatedRequest: false,
				isConversationRequest: false,
				interactionTypeOverride: 'conversation-background',
			}, token);
			return response;
		};

		const response = await this.requestLogger.captureInvocation(capturingToken, doRequest);
		if (token.isCancellationRequested) {
			return '';
		}

		if (response.type === ChatFetchResponseType.Success) {
			let title = response.value.trim();
			if (title.match(/^".*"$/)) {
				title = title.slice(1, -1);
			}

			if (title.includes('can\'t assist with that')) {
				return undefined;
			}

			return title;
		} else {
			this.logService.error(`Failed to fetch conversation title because of response type (${response.type}) and reason (${response.reason})`);
			return '';
		}
	}
}

/**
 * Picks the model a `vendor/id` or `vendor/group/id` identifier names from the models of that
 * vendor. Never guesses: an identifier that matches no model gives `undefined`.
 */
export function findModelByIdentifier(models: readonly vscode.LanguageModelChat[], modelIdentifier: string): vscode.LanguageModelChat | undefined {
	const slash = modelIdentifier.indexOf('/');
	if (slash <= 0) {
		return undefined;
	}
	const vendor = modelIdentifier.substring(0, slash);
	const rest = modelIdentifier.substring(slash + 1);
	const ofVendor = models.filter(m => m.vendor === vendor);
	// `vendor/id` first; a model id may itself contain `/`.
	const exact = ofVendor.filter(m => m.id === rest);
	if (exact.length === 1) {
		return exact[0];
	}
	// `vendor/group/id`: the id is the tail. Only an unambiguous match counts,
	// never a guess between models that share an id across groups.
	const byTail = ofVendor.filter(m => rest.endsWith('/' + m.id));
	return byTail.length === 1 ? byTail[0] : undefined;
}
