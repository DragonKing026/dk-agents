/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Drop-in replacement for `vscode-tas-client`: same API, but no experimentation service is ever
 * contacted. Every flight is off and every treatment variable is `undefined`, so callers fall
 * back to their defaults. Nothing is read from or written to the memento, and nothing is sent
 * to the telemetry object.
 */

const TargetPopulation = {
	Team: 'team',
	Internal: 'internal',
	Insiders: 'insider',
	Public: 'public',
};

class OfflineExperimentationService {

	constructor() {
		this.initializePromise = Promise.resolve();
		this.initialFetch = Promise.resolve();
	}

	isFlightEnabled() { return false; }
	isCachedFlightEnabled() { return Promise.resolve(false); }
	isFlightEnabledAsync() { return Promise.resolve(false); }
	getTreatmentVariable() { return undefined; }
	getTreatmentVariableAsync() { return Promise.resolve(undefined); }
}

function getExperimentationService() {
	return new OfflineExperimentationService();
}

function getExperimentationServiceAsync() {
	return Promise.resolve(new OfflineExperimentationService());
}

Object.defineProperty(exports, '__esModule', { value: true });
exports.TargetPopulation = TargetPopulation;
exports.getExperimentationService = getExperimentationService;
exports.getExperimentationServiceAsync = getExperimentationServiceAsync;
