/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function wrapEventNameForPrefixRemoval(eventName: string): string {
	return `wrapped-telemetry-event-name-${eventName}-wrapped-telemetry-event-name`;
}

export function unwrapEventNameFromPrefix(eventName: string): string {
	const match = eventName.match(/wrapped-telemetry-event-name-(.*?)-wrapped-telemetry-event-name/);
	return match ? match[1] : eventName;
}
