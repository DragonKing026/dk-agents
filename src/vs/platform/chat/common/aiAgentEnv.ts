/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-vendor convention env var that announces which AI agent is driving a
 * process. Child processes inherit it; `gh` in particular reads it and reports
 * the value in its `User-Agent`, which lets downstream activity be attributed to
 * the originating AI experience without touching the user's global environment.
 */
export const AiAgentEnvVar = 'AI_AGENT';

/**
 * The value DK Code announces for processes it spawns on behalf of an agent
 * session. It is `dk_code_agent`, so tools such as `gh` do not attribute their
 * traffic to GitHub Copilot. `gh` only accepts values matching `[a-zA-Z0-9_-]+`.
 * User hooks can read the variable to tell that DK Code started the session.
 *
 * This must be set for *every* process an agent session spawns — the local
 * (in-workbench) harness terminal tool, the agent host process and every agent
 * SDK subprocess it launches.
 */
export const AiAgentEnvValue = 'dk_code_agent';
