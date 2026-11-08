/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

export interface IKeyValueStorage {
	getValue<T>(key: string, defaultValue?: T): Promise<T | undefined>;
	setValue<T>(key: string, value: T): void;
}

export interface IExperimentationFilterProvider {
	getFilters(): Map<string, any>;
}

export interface IExperimentationTelemetry {
	setSharedProperty(name: string, value: string): void;
	postEvent(eventName: string, props: Map<string, string>): void;
}

export interface IExperimentationService {
	readonly initializePromise: Promise<void>;
	readonly initialFetch: Promise<void>;
	isFlightEnabled(flight: string): boolean;
	isCachedFlightEnabled(flight: string): Promise<boolean>;
	isFlightEnabledAsync(flight: string): Promise<boolean>;
	getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined;
	getTreatmentVariableAsync<T extends boolean | number | string>(configId: string, name: string, checkCache?: boolean): Promise<T | undefined>;
}

export declare enum TargetPopulation {
	Team = 'team',
	Internal = 'internal',
	Insiders = 'insider',
	Public = 'public'
}

export declare function getExperimentationService(extensionName: string, extensionVersion: string, targetPopulation: TargetPopulation, telemetry: IExperimentationTelemetry, memento: vscode.Memento, ...filterProviders: IExperimentationFilterProvider[]): IExperimentationService;

export declare function getExperimentationServiceAsync(extensionName: string, extensionVersion: string, targetPopulation: TargetPopulation, telemetry: IExperimentationTelemetry, memento: vscode.Memento, ...filterProviders: IExperimentationFilterProvider[]): Promise<IExperimentationService>;
