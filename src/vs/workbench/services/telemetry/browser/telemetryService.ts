/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ClassifiedEvent, IGDPRProperty, OmitMetadata, StrictPropertyCheck } from '../../../../platform/telemetry/common/gdprTypings.js';
import { ITelemetryData, ITelemetryService, TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IRequestService, NO_FETCH_TELEMETRY } from '../../../../platform/request/common/request.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

export class TelemetryService extends Disposable implements ITelemetryService {

	declare readonly _serviceBrand: undefined;

	private impl: ITelemetryService = NullTelemetryService;
	public readonly sendErrorTelemetry = false;

	get sessionId(): string { return this.impl.sessionId; }
	get machineId(): string { return this.impl.machineId; }
	get sqmId(): string { return this.impl.sqmId; }
	get devDeviceId(): string { return this.impl.devDeviceId; }
	get firstSessionDate(): string { return this.impl.firstSessionDate; }
	get msftInternal(): boolean | undefined { return this.impl.msftInternal; }

	constructor(
		@IProductService productService: IProductService,
		@IRequestService requestService: IRequestService
	) {
		super();

		this._register(requestService.onDidCompleteRequest(e => {
			if (e.callSite === NO_FETCH_TELEMETRY || productService.quality === 'stable') {
				return;
			}
			type FetchCallClassification = {
				owner: 'lramos15';
				comment: 'Tracks fetch requests made through the request service';
				callSite: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The call site that initiated the request.' };
				latency: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'Time in milliseconds for the request to complete.' };
				statusCode: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'HTTP status code of the response.' };
			};
			type FetchCallEvent = {
				callSite: string;
				latency: number;
				statusCode: number | undefined;
			};
			this.publicLog2<FetchCallEvent, FetchCallClassification>('fetchCall', {
				callSite: e.callSite,
				latency: e.latency,
				statusCode: e.statusCode,
			});
		}));
	}

	setExperimentProperty(name: string, value: string): void {
		return this.impl.setExperimentProperty(name, value);
	}

	setCommonProperty(name: string, value: string | boolean | undefined): void {
		this.impl.setCommonProperty(name, value);
	}

	get telemetryLevel(): TelemetryLevel {
		return this.impl.telemetryLevel;
	}

	publicLog(eventName: string, data?: ITelemetryData) {
		this.impl.publicLog(eventName, data);
	}

	publicLog2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(eventName: string, data?: StrictPropertyCheck<T, E>) {
		this.publicLog(eventName, data as ITelemetryData);
	}

	publicLogError(errorEventName: string, data?: ITelemetryData) {
		this.impl.publicLog(errorEventName, data);
	}

	publicLogError2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(eventName: string, data?: StrictPropertyCheck<T, E>) {
		this.publicLogError(eventName, data as ITelemetryData);
	}
}

registerSingleton(ITelemetryService, TelemetryService, InstantiationType.Delayed);
