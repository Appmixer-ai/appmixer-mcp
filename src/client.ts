import { withTimeout } from './cancellation.js';
import { ApiError } from './errors.js';
import type { Config } from './config.js';

const TOKEN_EXPIRY_CLEARANCE_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    timeoutMs?: number;
}

export interface GatewayToolFunction {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export interface Gateway {
    flowId: string;
    componentId: string;
    webhook: string;
    tools: { type: string; function: GatewayToolFunction }[];
}

export interface FlowTestBody {
    componentId: string;
    inputData?: unknown;
    payload?: unknown;
    options?: Record<string, unknown>;
}

/** SSE events are separated by a blank line; servers may use LF or CRLF. */
const SSE_BLOCK_SEPARATOR = /\r?\n\r?\n/;

function parseSseBlock(block: string): { event: string; data: unknown } | undefined {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length && event === 'message') return undefined; // Comment/heartbeat.
    const raw = dataLines.join('\n');
    try {
        return { event, data: JSON.parse(raw) };
    } catch {
        return { event, data: raw };
    }
}

/** Decode a JWT payload without verifying the signature (client-side expiry check only). */
export function jwtExpiresAt(token: string): number | undefined {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? payload.exp : undefined;
    } catch {
        return undefined;
    }
}

export class AppmixerClient {

    private token?: string;
    private refreshPromise?: Promise<string>;
    private componentNames = new Map<string, Set<string>>();

    constructor(private readonly config: Pick<Config, 'baseUrl' | 'accessToken' | 'username' | 'password'>) {
        this.token = config.accessToken;
    }

    get baseUrl(): string {
        return this.config.baseUrl;
    }

    private tokenUsable(): boolean {
        if (!this.token) return false;
        const exp = jwtExpiresAt(this.token);
        if (exp === undefined) return false;
        return exp > Date.now() / 1000 + TOKEN_EXPIRY_CLEARANCE_SECONDS;
    }

    private canReauthenticate(): boolean {
        return Boolean(this.config.username && this.config.password);
    }

    /** Returns a valid token, re-authenticating with username/password when possible. */
    async ensureToken(): Promise<string> {
        if (this.tokenUsable()) return this.token as string;
        if (!this.canReauthenticate()) {
            if (this.token) return this.token; // Let the API decide; we cannot renew it anyway.
            throw new ApiError(
                'No usable access token and no credentials to authenticate with.',
                401, 'POST', `${this.config.baseUrl}/user/auth`);
        }
        return this.refreshToken();
    }

    private refreshToken(): Promise<string> {
        // Single-flight: concurrent calls share one login request.
        if (!this.refreshPromise) {
            this.refreshPromise = this.login().finally(() => {
                this.refreshPromise = undefined;
            });
        }
        return this.refreshPromise;
    }

    private async login(): Promise<string> {
        const url = `${this.config.baseUrl}/user/auth`;
        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: this.config.username,
                password: this.config.password
            })
        }, DEFAULT_TIMEOUT_MS);
        if (!response.ok) {
            throw new ApiError(
                `Authentication failed: ${response.status} ${response.statusText}`,
                response.status, 'POST', url, await safeJson(response));
        }
        const data = await response.json() as { token: string };
        this.token = data.token;
        return this.token;
    }

    private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        // Aborts on the request timeout or when the MCP client cancels the call.
        const { signal, done } = withTimeout(timeoutMs);
        try {
            return await fetch(url, { ...init, signal });
        } catch (err) {
            if (signal.aborted) {
                throw new ApiError(`Request aborted (timeout ${timeoutMs} ms or client cancellation)`,
                    undefined, init.method || 'GET', url);
            }
            throw new ApiError(`Network error: ${(err as Error).message}`, undefined,
                init.method || 'GET', url);
        } finally {
            done();
        }
    }

    /**
     * Perform an authenticated request. `path` may be a path relative to the
     * tenant base URL or an absolute URL (gateway webhooks).
     */
    async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.requestInternal<T>(path, options, true);
    }

    private async requestInternal<T>(path: string, options: RequestOptions, allowRetry: boolean): Promise<T> {
        const { method = 'GET', body, query, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

        const url = new URL(/^https?:\/\//.test(path) ? path : `${this.config.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }

        const token = await this.ensureToken();
        const init: RequestInit = {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }

        const response = await this.fetchWithTimeout(url.toString(), init, timeoutMs);

        if (response.status === 401 && allowRetry && this.canReauthenticate()) {
            this.token = undefined;
            return this.requestInternal<T>(path, options, false);
        }
        if (!response.ok) {
            const errorBody = await safeJson(response);
            throw new ApiError(
                `${response.status} ${response.statusText}`,
                response.status, method, url.toString(), errorBody);
        }

        const text = await response.text();
        try {
            return JSON.parse(text) as T;
        } catch {
            return text as T;
        }
    }

    // ---- Domain methods -------------------------------------------------

    getFlows(options: { pattern?: string; filter?: string; limit?: number; offset?: number } = {}) {
        return this.request<Record<string, unknown>[]>('/flows', {
            query: {
                pattern: options.pattern,
                filter: options.filter,
                limit: options.limit,
                offset: options.offset,
                sort: 'mtime:-1',
                projection: '-thumbnail'
            }
        });
    }

    getFlow(id: string) {
        return this.request<Record<string, unknown>>(`/flows/${encodeURIComponent(id)}`);
    }

    deleteFlow(id: string) {
        return this.request(`/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    commandFlow(id: string, command: 'start' | 'stop') {
        return this.request(`/flows/${encodeURIComponent(id)}/coordinator`, {
            method: 'POST',
            body: { command }
        });
    }

    /** Verify the current credentials against the tenant; throws ApiError 401 when rejected. */
    getCurrentUser() {
        return this.request<Record<string, unknown>>('/user');
    }

    /**
     * Call a component's static function — the endpoint behind the `source`
     * URLs in component manifests, which the Designer uses to resolve dynamic
     * inspector options and output-port variables at runtime.
     */
    callComponentFunction(
        type: string,
        body: { componentId: string; properties?: Record<string, unknown>; messages?: Record<string, unknown> },
        outPort?: string
    ) {
        const segments = type.split('.');
        if (segments.length !== 4) {
            throw new ApiError(`Invalid component type "${type}" (expected vendor.service.module.Component).`,
                undefined, 'POST', `${this.config.baseUrl}/component/...`);
        }
        const path = `/component/${segments.map(encodeURIComponent).join('/')}`;
        return this.request<unknown>(path, { method: 'POST', body, query: { outPort } });
    }

    getTriggerUrl(componentId: string) {
        return this.request<unknown>(`/triggers/${encodeURIComponent(componentId)}/url`);
    }

    triggerComponent(
        flowId: string,
        componentId: string,
        options: { method?: string; body?: unknown; query?: Record<string, string> } = {}
    ) {
        const { method = 'POST', body, query } = options;
        return this.request(
            `/flows/${encodeURIComponent(flowId)}/components/${encodeURIComponent(componentId)}`,
            { method, body: method === 'GET' ? undefined : (body ?? {}), query });
    }

    sendAppEvent(event: string, data: unknown) {
        return this.request(
            `/plugins/appmixer/utils/appevents/events/${encodeURIComponent(event)}`,
            { method: 'POST', body: data ?? {} });
    }

    cloneFlow(id: string, body: Record<string, unknown> = {}) {
        return this.request<{ flowId: string }>(`/flows/${encodeURIComponent(id)}/clone`,
            { method: 'POST', body });
    }

    listFlowVersions(flowId: string, options: { limit?: number; offset?: number } = {}) {
        return this.request<{ items?: Record<string, unknown>[]; totalCount?: number }>(
            `/flows/${encodeURIComponent(flowId)}/versions`,
            { query: { limit: options.limit, offset: options.offset } });
    }

    createFlowVersion(flowId: string, label?: string) {
        return this.request<Record<string, unknown>>(
            `/flows/${encodeURIComponent(flowId)}/versions`,
            // 'manual' is the only type a user may create besides autosave.
            { method: 'POST', body: label ? { type: 'manual', label } : { type: 'manual' } });
    }

    restoreFlowVersion(flowId: string, versionId: string) {
        return this.request<Record<string, unknown>>(
            `/flows/${encodeURIComponent(flowId)}/versions/${encodeURIComponent(versionId)}/restore`,
            { method: 'POST' });
    }

    listStores() {
        return this.request<{ storeId: string; name: string }[]>('/stores');
    }

    createStore(name: string) {
        return this.request<{ storeId: string }>('/stores', { method: 'POST', body: { name } });
    }

    getStoreRecords(storeId: string, options: { limit?: number; offset?: number } = {}) {
        return this.request<Record<string, unknown>[]>('/store', {
            query: { storeId, limit: options.limit, offset: options.offset }
        });
    }

    getStoreRecordCount(storeId: string) {
        return this.request<{ count?: number }>('/store/count', { query: { storeId } });
    }

    /** The request body is stored as the record's value verbatim. */
    setStoreRecord(storeId: string, key: string, value: Record<string, unknown>) {
        return this.request<Record<string, unknown>>(
            `/store/${encodeURIComponent(storeId)}/${encodeURIComponent(key)}`,
            { method: 'POST', body: value });
    }

    deleteStoreRecord(storeId: string, key: string) {
        return this.request(
            `/store/${encodeURIComponent(storeId)}/${encodeURIComponent(key)}`, { method: 'DELETE' });
    }

    getModifiers() {
        return this.request<{
            categories?: Record<string, { label?: string }>;
            modifiers?: Record<string, Record<string, unknown>>;
        }>('/modifiers');
    }

    getUnprocessedMessages(options: { flowId?: string; correlationId?: string; limit?: number; offset?: number } = {}) {
        return this.request<Record<string, unknown>[]>('/unprocessed-messages', {
            query: {
                flowId: options.flowId,
                correlationId: options.correlationId,
                limit: options.limit,
                offset: options.offset
            }
        });
    }

    getUnprocessedMessage(messageId: string) {
        return this.request<Record<string, unknown>>(
            `/unprocessed-messages/${encodeURIComponent(messageId)}`);
    }

    retryUnprocessedMessage(messageId: string) {
        return this.request(
            `/unprocessed-messages/${encodeURIComponent(messageId)}/retry`, { method: 'POST' });
    }

    deleteUnprocessedMessage(messageId: string) {
        return this.request(
            `/unprocessed-messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    }

    getLogs(flowId: string, options: { query?: string; size?: number } = {}) {
        return this.request<{ hits?: Record<string, unknown>[] }>('/logs', {
            query: { flowId, query: options.query, size: options.size }
        });
    }

    getApps() {
        return this.request<Record<string, { name: string; label?: string; description?: string; category?: string }>>('/apps');
    }

    getComponents(app: string) {
        return this.request<Record<string, unknown>[]>('/apps/components', { query: { app } });
    }

    /** Component type names of an app, cached for the lifetime of this client. */
    async getComponentNames(app: string): Promise<Set<string>> {
        const cached = this.componentNames.get(app);
        if (cached) return cached;
        const components = await this.getComponents(app);
        const names = new Set(components
            .map(component => component.name)
            .filter((name): name is string => typeof name === 'string'));
        this.componentNames.set(app, names);
        return names;
    }

    getAccounts() {
        return this.request<Record<string, unknown>[]>('/accounts');
    }

    createFlow(body: Record<string, unknown>) {
        return this.request<{ flowId: string }>('/flows', { method: 'POST', body });
    }

    updateFlow(id: string, body: Record<string, unknown>, options: { force?: boolean } = {}) {
        return this.request<Record<string, unknown>>(`/flows/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body,
            query: options.force ? { forceUpdate: 'true' } : undefined
        });
    }

    validateFlow(id: string) {
        return this.request<{ errors?: unknown[] }>(`/flows/${encodeURIComponent(id)}/validate`);
    }

    fetchFlowVariables(flowId: string) {
        return this.request<{ components?: Record<string, unknown>; flow?: unknown[] }>(
            `/variables/${encodeURIComponent(flowId)}/fetch`, { method: 'POST', body: {} });
    }

    getFlowAccounts(flowId: string) {
        return this.request<Record<string, unknown>[]>(`/accounts/flow/${encodeURIComponent(flowId)}`);
    }

    assignAccount(componentId: string, accountId: string) {
        return this.request(
            `/auth/component/${encodeURIComponent(componentId)}/${encodeURIComponent(accountId)}`,
            { method: 'PUT' });
    }

    /**
     * Run a component test (POST /flows/:id/test) and collect the SSE result
     * events until test:done / test:error or the timeout elapses. Shares the
     * token lifecycle and error normalization of the regular request path.
     */
    async runFlowTest(
        flowId: string,
        body: FlowTestBody,
        overallTimeoutMs: number
    ): Promise<{ event: string; data: unknown }[]> {
        try {
            return await this.streamFlowTest(flowId, body, overallTimeoutMs);
        } catch (err) {
            if (err instanceof ApiError && err.status === 401 && this.canReauthenticate()) {
                this.token = undefined;
                return this.streamFlowTest(flowId, body, overallTimeoutMs);
            }
            throw err;
        }
    }

    private async streamFlowTest(
        flowId: string,
        body: FlowTestBody,
        overallTimeoutMs: number
    ): Promise<{ event: string; data: unknown }[]> {

        const token = await this.ensureToken();
        const url = `${this.config.baseUrl}/flows/${encodeURIComponent(flowId)}/test`;
        const { signal: controllerSignal, done: clearTimeoutTimer } = withTimeout(overallTimeoutMs);
        const controller = { signal: controllerSignal };
        const events: { event: string; data: unknown }[] = [];

        try {
            let response: Response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (err) {
                throw controller.signal.aborted
                    ? new ApiError(`Request timed out after ${overallTimeoutMs} ms`, undefined, 'POST', url)
                    : new ApiError(`Network error: ${(err as Error).message}`, undefined, 'POST', url);
            }
            if (!response.ok || !response.body) {
                throw new ApiError(`${response.status} ${response.statusText}`,
                    response.status, 'POST', url, await safeJson(response));
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finished = false;
            try {
                while (!finished) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let boundary;
                    while (!finished && (boundary = SSE_BLOCK_SEPARATOR.exec(buffer)) !== null) {
                        const block = buffer.slice(0, boundary.index);
                        buffer = buffer.slice(boundary.index + boundary[0].length);
                        const parsed = parseSseBlock(block);
                        if (!parsed) continue;
                        events.push(parsed);
                        finished = parsed.event === 'test:done' || parsed.event === 'test:error';
                    }
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    throw new ApiError(`Test stream failed: ${(err as Error).message}`,
                        undefined, 'POST', url);
                }
                events.push({
                    event: 'client:timeout',
                    data: `No test result within ${overallTimeoutMs} ms; collected ${events.length} events.`
                });
            } finally {
                // We stop reading as soon as the terminal event arrives.
                await reader.cancel().catch(() => undefined);
            }
        } finally {
            clearTimeoutTimer();
        }
        return events;
    }

    getGateways() {
        return this.request<Gateway[]>('/plugins/appmixer/ai/mcptools/gateways');
    }

    callGatewayTool(webhook: string, name: string, args: unknown) {
        return this.request(webhook, {
            method: 'POST',
            body: { function: { name, arguments: args } },
            timeoutMs: 130_000 // Gateway tool polling on the Appmixer side can take up to 120 s.
        });
    }
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}
