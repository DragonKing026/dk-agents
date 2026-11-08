/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import * as util from 'util';
import * as vscode from 'vscode';

import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IEnvService } from '../../../platform/env/common/envService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { collectErrorMessages, ILogService } from '../../../platform/log/common/logService';
import { outputChannel } from '../../../platform/log/vscode/outputChannelLogTarget';
import { FetchEvent, IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IFetcher } from '../../../platform/networking/common/networking';
import { NodeFetcher } from '../../../platform/networking/node/nodeFetcher';
import { NodeFetchFetcher } from '../../../platform/networking/node/nodeFetchFetcher';
import { ElectronFetcher } from '../../../platform/networking/vscode-node/electronFetcher';
import { getShadowedConfig } from '../../../platform/networking/vscode-node/fetcherServiceImpl';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';

import { timeout } from '../../../util/vs/base/common/async';
import { Disposable, MutableDisposable } from '../../../util/vs/base/common/lifecycle';
import { EXTENSION_ID } from '../../common/constants';

interface ProxyAgentLog {
	trace(message: string, ...args: any[]): void;
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string | Error, ...args: any[]): void;
}

interface ProxyAgentParams {
	log: ProxyAgentLog;
	loadSystemCertificatesFromNode: () => boolean | undefined;
}

interface ResolvedProxyInfo {
	url: string | undefined;
	type: 'DIRECT' | 'PROXY' | 'HTTP' | 'HTTPS' | 'SOCKS' | 'SOCKS5' | 'SOCKS4' | 'EMPTY' | 'UNRECOGNIZED';
	source: 'localhost' | 'noProxyConfig' | 'noProxyEnv' | 'setting' | 'env' | 'remote' | 'system_cached' | 'system' | 'fallback';
}

interface ProxyAgent {
	loadSystemCertificates?(params: ProxyAgentParams): Promise<string[]>;
	resolveProxyURL?(url: string): Promise<string | undefined>;
	resolveProxyByURL?(url: string): Promise<ResolvedProxyInfo>;
}

export class LoggingActionsContrib {
	constructor(
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IEnvService private envService: IEnvService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@ICAPIClientService private readonly capiClientService: ICAPIClientService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@ILogService private logService: ILogService,
	) {
		const collectDiagnostics = async () => {
			const document = await vscode.workspace.openTextDocument({ language: 'markdown' });
			const editor = await vscode.window.showTextDocument(document);
			const electronConfig = getShadowedConfig<boolean>(this.configurationService, this.experimentationService, ConfigKey.Shared.DebugUseElectronFetcher, ConfigKey.TeamInternal.DebugExpUseElectronFetcher);
			const nodeConfig = getShadowedConfig<boolean>(this.configurationService, this.experimentationService, ConfigKey.Shared.DebugUseNodeFetcher, ConfigKey.TeamInternal.DebugExpUseNodeFetcher);
			const nodeFetchConfig = getShadowedConfig<boolean>(this.configurationService, this.experimentationService, ConfigKey.Shared.DebugUseNodeFetchFetcher, ConfigKey.TeamInternal.DebugExpUseNodeFetchFetcher);
			const ext = vscode.extensions.getExtension(EXTENSION_ID);
			const product = require(path.join(vscode.env.appRoot, 'product.json'));
			await appendText(editor, `## GitHub Copilot Chat

- Extension: ${this.envService.getVersion()} (${this.envService.getBuildType()})
- VS Code: ${vscode.version} (${product.commit || 'out-of-source'})
- OS: ${os.platform()} ${os.release()} ${os.arch()}${vscode.env.remoteName ? `
- Remote Name: ${vscode.env.remoteName}` : ''}${vscode.env.remoteName && ext ? `
- Extension Kind: ${vscode.ExtensionKind[ext.extensionKind]}` : ''}
- GitHub Account: ${this.authService.anyGitHubSession?.account.label || 'Signed Out'}

## Network

User Settings:
\`\`\`json${getNetworkSettings()}
  "github.copilot.advanced.debug.useElectronFetcher": ${electronConfig},
  "github.copilot.advanced.debug.useNodeFetcher": ${nodeConfig},
  "github.copilot.advanced.debug.useNodeFetchFetcher": ${nodeFetchConfig}
\`\`\`${getProxyEnvVariables()}
`);
			const proxyAgent = loadVSCodeModule<ProxyAgent>('@vscode/proxy-agent');
			const loadSystemCertificatesFromNode = this.configurationService.getNonExtensionConfig<boolean>('http.systemCertificatesNode');
			const osCertificates = proxyAgent?.loadSystemCertificates ? await loadSystemCertificates(proxyAgent.loadSystemCertificates, loadSystemCertificatesFromNode, this.logService) : undefined;
			const urls = [
				{ url: this.capiClientService.dotcomAPIURL, expectedContent: 'current_user_url' },
				{ url: this.capiClientService.capiPingURL, expectedContent: 'OK' },
				{ url: this.capiClientService.proxyBaseURL + '/_ping', expectedContent: '"status":"ok"' },
			];
			const isGHEnterprise = this.capiClientService.dotcomAPIURL !== 'https://api.github.com';
			const timeoutSeconds = 10;
			const electronFetcher = ElectronFetcher.create(this.envService);
			const electronCurrent = !!electronFetcher && electronConfig;
			const nodeCurrent = !electronCurrent && nodeConfig;
			const nodeFetchCurrent = !electronCurrent && !nodeCurrent && nodeFetchConfig;
			const nodeCurrentFallback = !electronCurrent && !nodeFetchCurrent;
			const activeFetcher = this.fetcherService.getUserAgentLibrary();
			const nodeFetcher = { name: 'Node.js https', fetcher: new NodeFetcher(this.envService), current: nodeCurrent || nodeCurrentFallback };
			const nodeFetchFetcher = { name: 'Node.js fetch', fetcher: new NodeFetchFetcher(this.envService), current: nodeFetchCurrent };
			const fetchers = [
				{ name: 'Electron fetch', fetcher: electronFetcher, current: electronCurrent },
				nodeFetcher,
				nodeFetchFetcher,
			];
			const dnsLookup = util.promisify(dns.lookup);
			for (const { url, expectedContent } of urls) {
				const authHeaders = await this.getAuthHeaders(isGHEnterprise, url);
				const host = new URL(url).hostname;
				await appendText(editor, `\nConnecting to ${url}:\n`);
				for (const family of [4, 6]) {
					await appendText(editor, `- DNS ipv${family} Lookup: `);
					const start = Date.now();
					try {
						const dnsResult = await Promise.race([dnsLookup(host, { family }), timeout(timeoutSeconds * 1000)]);
						if (dnsResult) {
							await appendText(editor, `${dnsResult.address} (${Date.now() - start} ms)\n`);
						} else {
							await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
						}
					} catch (err) {
						await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
					}
				}
				let probeProxyURL: string | undefined;
				if (proxyAgent?.resolveProxyURL) {
					await appendText(editor, `- Proxy URL: `);
					const start = Date.now();
					try {
						const proxyURL = await Promise.race([proxyAgent.resolveProxyURL(url), timeoutAfter(timeoutSeconds * 1000)]);
						if (proxyURL === 'timeout') {
							await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
						} else {
							await appendText(editor, `${proxyURL || 'None'} (${Date.now() - start} ms)\n`);
							probeProxyURL = proxyURL;
						}
					} catch (err) {
						await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
					}
				}
				if (proxyAgent?.loadSystemCertificates && probeProxyURL?.startsWith('https:')) {
					const tlsOrig: typeof tls | undefined = (tls as any).__vscodeOriginal;
					if (tlsOrig) {
						await appendText(editor, `- Proxy TLS: `);
						if (!osCertificates) {
							await appendText(editor, `(failed to load system certificates) `);
						}
						const start = Date.now();
						try {
							const result = await Promise.race([tlsConnect(tlsOrig, probeProxyURL, [...tls.rootCertificates, ...(osCertificates || [])]), timeout(timeoutSeconds * 1000)]);
							if (result) {
								await appendText(editor, `${result} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
						}
					}
				}
				if (probeProxyURL) {
					const httpx: typeof https | typeof http | undefined = probeProxyURL.startsWith('https:') ? (https as any).__vscodeOriginal : (http as any).__vscodeOriginal;
					if (httpx) {
						await appendText(editor, `- Proxy Connection: `);
						const start = Date.now();
						try {
							const result = await Promise.race([proxyConnect(httpx, probeProxyURL, url), timeout(timeoutSeconds * 1000)]);
							if (result) {
								const headers = Object.keys(result.headers).map(header => `\n	${header}: ${result.headers[header]}`);
								const text = `${result.statusCode} ${result.statusMessage}${headers.join('')}`;
								await appendText(editor, `${text} (${Date.now() - start} ms)\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${err?.message}\n`);
						}
					}
				}
				for (const { name, fetcher, current } of fetchers) {
					await appendText(editor, `- ${name}${current ? ' (configured)' : fetcher?.getUserAgentLibrary() === activeFetcher ? ' (active)' : ''}: `);
					if (fetcher) {
						const start = Date.now();
						try {
							const response = await Promise.race([fetcher.fetch(url, { headers: authHeaders, callSite: 'diagnostics-fetcher-probe' }), timeout(timeoutSeconds * 1000)]);
							if (response) {
								let contentNote = '';
								try {
									const body = await response.text();
									if (!body.includes(expectedContent)) {
										contentNote = ` - unexpected content: ${formatUnexpectedContent(body)} (expected: '${expectedContent}')`;
									}
								} catch (bodyErr) {
									contentNote = ` - failed to read content: ${collectErrorMessages(bodyErr)}`;
								}
								await appendText(editor, `HTTP ${response.status} (${Date.now() - start} ms)${contentNote}\n`);
							} else {
								await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
							}
						} catch (err) {
							await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
						}
					} else {
						await appendText(editor, 'Unavailable\n');
					}
				}
			}

			const currentFetcher = fetchers.find((entry): entry is typeof entry & { fetcher: IFetcher } => entry.current && !!entry.fetcher) ?? nodeFetcher;
			await appendText(editor, `\nNumber of system certificates: ${osCertificates?.length ?? 'failed to load'}\n`);

			const activeFetcherName = fetchers.find(entry => entry.fetcher?.getUserAgentLibrary() === activeFetcher)?.name ?? activeFetcher;
			const notes = [`- Active fetcher: ${activeFetcherName}.`];
			if (currentFetcher.fetcher.getUserAgentLibrary() !== activeFetcher) {
				notes.push(`- The active fetcher differs from the configured fetcher (${currentFetcher.name}). This can happen after a recent configuration change or an automatic fallback; reload the window or restart VS Code to apply the configured fetcher.`);
			}
			const proxySupport = vscode.workspace.getConfiguration().get<string>('http.proxySupport');
			if (proxySupport !== 'override') {
				notes.push(`- The \`"http.proxySupport"\` setting is set to \`"${proxySupport}"\`. The recommended default is \`"override"\`, which generally works best.`);
			}
			notes.push(`- For corporate networks also see: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).`);
			await appendText(editor, `
## Notes

${notes.join('\n')}`);

			return document.getText();
		};
		this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.debug.collectDiagnostics', collectDiagnostics));
		// Internal command is not declared in package.json so it can be used from the welcome views while the extension is being activated.
		this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.debug.collectDiagnostics.internal', collectDiagnostics));
		this._context.subscriptions.push(vscode.commands.registerCommand('github.copilot.debug.showOutputChannel.internal', () => outputChannel.show()));
		this._context.subscriptions.push(new NetworkStatus(this.fetcherService, this.configurationService, this.experimentationService));
	}

	private async getAuthHeaders(isGHEnterprise: boolean, url: string) {
		const authHeaders: Record<string, string> = {};
		if (isGHEnterprise) {
			let token = '';
			if (url === this.capiClientService.dotcomAPIURL) {
				token = this.authService.anyGitHubSession?.accessToken || '';
			} else {
				try {
					token = (await this.authService.getCopilotToken()).token;
				} catch (_err) {
					// Ignore error
					token = '';
				}
			}
			authHeaders['Authorization'] = `Bearer ${token}`;
		}
		return authHeaders;
	}
}

async function appendText(editor: vscode.TextEditor, string: string) {
	await editor.edit(builder => {
		builder.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, string);
	});
}

function timeoutAfter(ms: number) {
	return new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));
}

/**
 * Formats an unexpected response body for single-line display: replaces line breaks with `\n`
 * indicators and truncates to 200 characters.
 */
function formatUnexpectedContent(body: string): string {
	const oneLine = body.replace(/\r\n|\r|\n/g, '\\n');
	return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

function loadVSCodeModule<T>(moduleName: string): T | undefined {
	const appRoot = vscode.env.appRoot;
	try {
		return require(`${appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return require(`${appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

async function loadSystemCertificates(load: NonNullable<ProxyAgent['loadSystemCertificates']>, loadSystemCertificatesFromNode: boolean | undefined, logService: ILogService): Promise<(string | Buffer)[] | undefined> {
	try {
		const certificates = await load({
			log: {
				trace(message: string, ..._args: any[]) {
					logService.trace(message);
				},
				debug(message: string, ..._args: any[]) {
					logService.debug(message);
				},
				info(message: string, ..._args: any[]) {
					logService.info(message);
				},
				warn(message: string, ..._args: any[]) {
					logService.warn(message);
				},
				error(message: string | Error, ..._args: any[]) {
					logService.error(typeof message === 'string' ? message : String(message));
				},
			} satisfies ProxyAgentLog,
			loadSystemCertificatesFromNode: () => loadSystemCertificatesFromNode,
		});
		return Array.isArray(certificates) ? certificates : undefined;
	} catch (err) {
		logService.error(err);
		return undefined;
	}
}

async function tlsConnect(tlsOrig: typeof tls, proxyURL: string, ca: (string | Buffer)[]) {
	return new Promise<string>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyURL);
		const socket = tlsOrig.connect({
			host: proxyUrlObj.hostname,
			port: parseInt(proxyUrlObj.port, 10),
			servername: proxyUrlObj.hostname,
			ca,
		}, () => {
			socket.end();
			resolve('Succeeded');
		});
		socket.on('error', reject);
	});
}

async function proxyConnect(httpx: typeof https | typeof http, proxyUrl: string, targetUrl: string, sanitize = false) {
	return new Promise<{ statusCode: number | undefined; statusMessage: string | undefined; headers: Record<string, string | string[]> }>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyUrl);
		const targetUrlObj = new URL(targetUrl);
		const targetHost = `${targetUrlObj.hostname}:${targetUrlObj.port || (targetUrlObj.protocol === 'https:' ? 443 : 80)}`;
		const options = {
			method: 'CONNECT',
			host: proxyUrlObj.hostname,
			port: proxyUrlObj.port,
			path: targetHost,
			headers: {
				Host: targetHost,
			},
			rejectUnauthorized: false,
		};
		const req = httpx.request(options);
		req.on('connect', (res, socket, head) => {
			const headers = ['proxy-authenticate', 'proxy-agent', 'server', 'via'].reduce((acc, header) => {
				const value = res.headers[header];
				if (value) {
					const doSanitize = sanitize && !['proxy-agent', 'server'].includes(header);
					acc[header] = doSanitize ? Array.isArray(value) ? value.map(sanitizeValue) : sanitizeValue(value) : value;
				}
				return acc;
			}, {} as Record<string, string | string[]>);
			socket.end();
			resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, headers });
		});
		req.on('error', reject);
		req.end();
	});
}

const networkSettingsIds = [
	'http.proxy',
	'http.noProxy',
	'http.proxyAuthorization',
	'http.proxyStrictSSL',
	'http.proxySupport',
	'http.electronFetch',
	'http.fetchAdditionalSupport',
	'http.proxyKerberosServicePrincipal',
	'http.systemCertificates',
	'http.systemCertificatesNode',
	'http.experimental.systemCertificatesV2',
	'http.useLocalProxyConfiguration',
	'telemetry.telemetryLevel',
	'telemetry.enableTelemetry',
	'telemetry.enableCrashReporter',
];
const alwaysShowSettingsIds = [
	'http.systemCertificatesNode',
	'telemetry.telemetryLevel',
];

function getNetworkSettings() {
	const configuration = vscode.workspace.getConfiguration();
	return networkSettingsIds.map(key => {
		const i = configuration.inspect(key);
		const v = configuration.get(key, i?.defaultValue);
		if (alwaysShowSettingsIds.includes(key) || v !== i?.defaultValue && !(Array.isArray(v) && Array.isArray(i?.defaultValue) && v.length === 0 && i?.defaultValue.length === 0)) {
			return `\n  "${key}": ${JSON.stringify(v)},`;
		}
		return '';
	}).join('');
}

function getProxyEnvVariables() {
	const res = [];
	const envVars = ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'];
	for (const env in process.env) {
		if (envVars.includes(env.toLowerCase())) {
			res.push(`\n- ${env}=${process.env[env]}`);
		}
	}
	return res.length ? `\n\nEnvironment Variables:${res.join('')}` : '';
}

const ids_paths = /(^|\b)[\p{L}\p{Nd}]+((=""?[^"]+""?)|(([.:=/"_-]+[\p{L}\p{Nd}]+)+))(\b|$)/giu;
export function sanitizeValue(input: string | undefined): string {
	return (input || '').replace(ids_paths, (m) => maskByClass(m));
}

function maskByClass(s: string): string {
	if (/^net::[A-Z_]+$/.test(s) || ['dev-container', 'attached-container', 'k8s-container', 'ssh-remote'].includes(s)) {
		return s;
	}
	return s.replace(/\p{Lu}|\p{Ll}|\p{Nd}/gu, (ch) => {
		if (/\p{Lu}/u.test(ch)) {
			return 'A';
		}
		if (/\p{Ll}/u.test(ch)) {
			return 'a';
		}
		return '0';
	});
}

class NetworkStatus extends Disposable {

	private readonly _statusBarItem: vscode.StatusBarItem;
	private readonly _events: FetchEvent[] = [];
	private readonly _fetchSubscription = this._register(new MutableDisposable());

	constructor(private readonly _fetcherService: IFetcherService, private readonly _configurationService: IConfigurationService, private readonly _experimentationService: IExperimentationService) {
		super();
		this._statusBarItem = this._register(vscode.window.createStatusBarItem('copilot.networkStatus', vscode.StatusBarAlignment.Right, -1000));
		this._statusBarItem.name = 'Copilot Network Status';
		this._register(_configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.TeamInternal.DebugShowNetworkStatus.fullyQualifiedId)) {
				this._update();
			}
		}));
		this._update();
	}

	private _isEnabled(): boolean {
		return this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.DebugShowNetworkStatus, this._experimentationService);
	}

	private _onEvent(event: FetchEvent): void {
		this._events.push(event);
		const cutoff = Date.now() - 5 * 60 * 1000;
		while (this._events.length > 0 && this._events[0].timestamp < cutoff) {
			this._events.shift();
		}
		this._update();
	}

	private _update(): void {
		const enabled = this._isEnabled();
		if (enabled && !this._fetchSubscription.value) {
			this._fetchSubscription.value = this._fetcherService.onDidFetch(e => this._onEvent(e));
		} else if (!enabled) {
			this._fetchSubscription.value = undefined;
			this._events.length = 0;
			this._statusBarItem.hide();
			return;
		}
		const latestById = new Map<string, FetchEvent>();
		for (const e of this._events) {
			latestById.set(e.internalId, e);
		}
		const latest = [...latestById.values()];
		const errors = latest.filter(e => e.outcome === 'error');
		this._statusBarItem.text = `Copilot Network: ${errors.length} errors / ${latest.length} total`;

		const byHostname = new Map<string, { total: number; errors: number; cancellations: number }>();
		for (const e of latest) {
			let entry = byHostname.get(e.hostname);
			if (!entry) {
				entry = { total: 0, errors: 0, cancellations: 0 };
				byHostname.set(e.hostname, entry);
			}
			entry.total++;
			if (e.outcome === 'error') {
				entry.errors++;
			} else if (e.outcome === 'cancel') {
				entry.cancellations++;
			}
		}
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`| Hostname | Errors | Cancellations | Total |\n`);
		tooltip.appendMarkdown(`|:--|--:|--:|--:|\n`);
		for (const [hostname, { total, errors, cancellations }] of [...byHostname].sort((a, b) => b[1].total - a[1].total)) {
			tooltip.appendMarkdown(`| ${hostname} | ${errors} | ${cancellations} | ${total} |\n`);
		}
		tooltip.appendMarkdown(`\n**${errors.length}** of **${latest.length}** network requests failed in the last 5 minutes`);
		this._statusBarItem.tooltip = tooltip;

		this._statusBarItem.show();
	}
}
