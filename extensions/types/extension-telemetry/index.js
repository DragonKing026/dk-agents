/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Drop-in replacement for `@vscode/extension-telemetry`: same API, but nothing is collected,
 * buffered or sent. Every method is a no-op, the telemetry level is always `off`.
 */
class TelemetryReporter {

	constructor() {
		this.telemetryLevel = 'off';
		this.onDidChangeTelemetryLevel = () => ({ dispose() { } });
	}

	setContextTag() { }
	getContextTag() { return undefined; }
	sendTelemetryEvent() { }
	sendRawTelemetryEvent() { }
	sendDangerousTelemetryEvent() { }
	sendTelemetryErrorEvent() { }
	sendDangerousTelemetryErrorEvent() { }
	sendDangerousTelemetryException() { }
	dispose() { return Promise.resolve(); }
}

Object.defineProperty(exports, '__esModule', { value: true });
exports.TelemetryReporter = TelemetryReporter;
exports.default = TelemetryReporter;
