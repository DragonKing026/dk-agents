/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';

export interface IAssignmentService {
	readonly _serviceBrand: undefined;

	readonly onDidRefetchAssignments: Event<void>;
	getTreatment<T extends string | number | boolean>(name: string): Promise<T | undefined>;
}

export function getInternalOrg(organisations: readonly string[] | undefined): 'vscode' | 'github' | 'microsoft' | undefined {
	const isVSCodeInternal = organisations?.includes('Visual-Studio-Code');
	const isGitHubInternal = organisations?.includes('github');
	const isMicrosoftInternal = organisations?.includes('microsoft') || organisations?.includes('ms-copilot') || organisations?.includes('MicrosoftCopilot');
	return isVSCodeInternal ? 'vscode' : isGitHubInternal ? 'github' : isMicrosoftInternal ? 'microsoft' : undefined;
}

/** Whether the account is staff or belongs to an internal org; the machine half is `verifyMicrosoftInternalDomain`. */
export function isInternalAccount(isStaff: boolean | undefined, organisations: readonly string[] | undefined): boolean {
	return isStaff === true || getInternalOrg(organisations) !== undefined;
}
