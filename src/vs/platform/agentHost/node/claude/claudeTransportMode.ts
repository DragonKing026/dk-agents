/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';

/**
 * Resolved Claude host transport. `proxy` routes Anthropic traffic through the
 * local Copilot-CAPI proxy (requires GitHub auth); `native` talks to Anthropic
 * directly on the user's own credentials (no GitHub).
 */
export type ClaudeTransportMode = 'proxy' | 'native';

/**
 * The authentication inputs {@link resolveClaudeTransportMode} decides over.
 */
export interface IClaudeTransportModeInputs {
	/** Whether a GitHub Copilot token has been captured (i.e. signed in). */
	readonly hasGitHubToken: boolean;
	/** Whether the SDK reported a Claude setup usable on the user's own credentials (see {@link isClaudeAccountSetUp}). */
	readonly hasExistingSetup: boolean;
}

/**
 * Which transport should the Claude provider use? Always `native`: DK Code runs
 * the user's own Claude Code CLI on the user's own login and never routes
 * Claude through the Copilot proxy, whatever the inputs say. The inputs are
 * kept so callers and the proxy code path stay untouched until that code is
 * removed.
 */
export function resolveClaudeTransportMode(_inputs: IClaudeTransportModeInputs): ClaudeTransportMode {
	// DK Code never routes Claude through the Copilot proxy: the Claude Code CLI
	// runs on the user's own login.
	return 'native';
}

/**
 * Whether the SDK's own account report describes a Claude setup that can serve
 * requests on the user's own credentials — the single rule behind both the
 * advertised requirement and the native model catalog. Only the SDK can answer
 * honestly: a `claude login` credential lives in the macOS keychain, invisible
 * to `process.env` and `~/.claude/settings.json` alike.
 *
 * The two branches must NOT be collapsed. `apiProvider` reports `'firstParty'`
 * even for an empty home directory, so it is a presence signal for nobody — it
 * is consulted only to spot a *third-party* backend (Bedrock, Vertex, a
 * gateway), whose credential fields the SDK documents as absent because auth is
 * external. Requiring a credential field there would lock every one of them out.
 *
 * Says *configured*, not *working*: verifying would cost a billable request per
 * check, and the failure being fixed here is genuinely set-up users locked out.
 */
export function isClaudeAccountSetUp(account: AccountInfo | undefined): boolean {
	if (!account) {
		return false;
	}
	if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') {
		return true;
	}
	// `tokenSource` spells "no credential" as `'none'` rather than absence;
	// `apiKeySource` has only ever been observed absent in that case.
	// The CLI's own `initialize` report of a subscription login (`claude login`)
	// carries the plan and the e-mail but no `tokenSource`, so either one also
	// means a usable account.
	return (account.tokenSource !== undefined && account.tokenSource !== 'none')
		|| account.apiKeySource !== undefined
		|| account.subscriptionType !== undefined
		|| account.email !== undefined;
}
