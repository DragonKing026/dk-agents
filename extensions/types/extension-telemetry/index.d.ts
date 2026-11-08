/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface TelemetryEventProperties {
	readonly [key: string]: string | import('vscode').TelemetryTrustedValue<string> | undefined;
}

export interface TelemetryEventMeasurements {
	readonly [key: string]: number | undefined;
}

export interface ReplacementOption {
	lookup: RegExp;
	replacementString?: string;
}

export interface AppInsightsClientOptions {
	endpointUrl?: string;
	commonProperties?: Record<string, string>;
	tagOverrides?: Record<string, string>;
}

export type CustomFetcher = (
	url: string,
	init?: { method: 'POST'; headers?: Record<string, string>; body?: string }
) => Promise<{ text: () => Promise<string>; status: number; headers: Iterable<[string, string]> }>;

/**
 * Same API as the `@vscode/extension-telemetry` reporter, but it never collects or sends anything.
 */
export class TelemetryReporter {
	constructor(connectionString?: string, replacementOptions?: ReplacementOption[], initializationOptions?: import('vscode').TelemetryLoggerOptions, customFetcher?: CustomFetcher, appInsightsOptions?: AppInsightsClientOptions);

	telemetryLevel: 'all' | 'error' | 'crash' | 'off';
	onDidChangeTelemetryLevel: import('vscode').Event<'all' | 'error' | 'crash' | 'off'>;

	setContextTag(key: string, value: string): void;
	getContextTag(key: string): string | undefined;
	sendTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements, tagOverrides?: Record<string, string>): void;
	sendRawTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements, tagOverrides?: Record<string, string>): void;
	sendDangerousTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements, tagOverrides?: Record<string, string>): void;
	sendTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements, tagOverrides?: Record<string, string>): void;
	sendDangerousTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements, tagOverrides?: Record<string, string>): void;
	sendDangerousTelemetryException(exception: Error, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements, tagOverrides?: Record<string, string>): void;
	dispose(): Promise<any>;
}

export default TelemetryReporter;
