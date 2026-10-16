import { EventSource } from 'eventsource';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { ApiError } from '../errors.js';
import { safeHandler, textResult } from '../format.js';
import { jsonSchemaToZod } from './json-schema-to-zod.js';

const REFRESH_DEBOUNCE_MS = 300;
const RECONNECT_BASE_DELAY_MS = 5_000;
/** Backoff ceiling: a permanently failing stream retries at most once a minute. */
const RECONNECT_MAX_DELAY_MS = 60_000;
/** How often to re-check a tenant where the mcptools plugin is not installed. */
const PLUGIN_RECHECK_DELAY_MS = 5 * 60_000;
const MAX_TOOL_NAME_LENGTH = 64;

export interface Logger {
    (message: string, detail?: unknown): void;
}

interface GatewayToolDefinition {
    description: string;
    parameters?: Record<string, unknown>;
    webhook: string;
    originalName: string;
}

interface RegisteredGatewayTool {
    handle: RegisteredTool;
    /** Identity of the definition the tool was registered from. */
    fingerprint: string;
}

function fingerprintOf(definition: GatewayToolDefinition): string {
    return JSON.stringify([
        definition.originalName,
        definition.description,
        definition.webhook,
        definition.parameters ?? null
    ]);
}

/**
 * Manages dynamic tools exposed by "MCP Gateway" components running in the
 * user's Appmixer flows. Tools are (re)registered whenever a gateway is added
 * or removed (SSE events from the mcptools plugin), emitting standard MCP
 * tools/list_changed notifications.
 *
 * The mcptools plugin ships separately from Appmixer core (see
 * docs/mcptools-endpoints.md). When its endpoints are missing (404) the manager
 * keeps the server working in API-only mode and re-checks periodically, so a
 * plugin installed later is picked up without a restart. Credentials rejected
 * by the tenant (401/403) disable the manager for good: retrying cannot help
 * and would turn every session into a stream of failing API calls.
 */
export class GatewayManager {

    private registered = new Map<string, RegisteredGatewayTool>();
    private eventSource?: EventSource;
    private refreshTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;
    private recheckTimer?: NodeJS.Timeout;
    private reconnectAttempts = 0;
    private pluginMissingLogged = false;
    private stopped = false;
    private disabled = false;

    constructor(
        private readonly server: McpServer,
        private readonly client: AppmixerClient,
        private readonly log: Logger
    ) {}

    async start(): Promise<void> {
        const available = await this.refresh();
        if (available) {
            await this.connectEvents();
        }
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.recheckTimer);
        this.eventSource?.close();
        this.eventSource = undefined;
    }

    /** Fetch gateways and reconcile registered tools. Returns false when the plugin is unavailable. */
    async refresh(): Promise<boolean> {
        if (this.stopped || this.disabled) return false;

        let gateways;
        try {
            gateways = await this.client.getGateways();
        } catch (err) {
            const status = err instanceof ApiError ? err.status : undefined;
            if (status === 401 || status === 403) {
                this.disable(`Appmixer rejected the credentials (HTTP ${status})`);
                return false;
            }
            if (status === 404) {
                if (!this.pluginMissingLogged) {
                    this.pluginMissingLogged = true;
                    this.log('MCP Gateway plugin (appmixer.ai.mcptools) is not installed on this ' +
                        'tenant; gateway tools disabled. API tools keep working.');
                }
                this.schedulePluginRecheck();
                return false;
            }
            this.log('Failed to fetch MCP gateways; keeping previously registered tools.', err);
            return true;
        }

        const desired = new Map<string, GatewayToolDefinition>();
        const taken = new Set<string>();

        for (const gateway of gateways || []) {
            for (const tool of gateway.tools || []) {
                if (tool?.function?.name && gateway.webhook) {
                    const name = uniqueName(sanitizeToolName(tool.function.name), taken);
                    taken.add(name);
                    desired.set(name, {
                        description: tool.function.description || `Appmixer MCP Gateway tool ${tool.function.name}`,
                        parameters: tool.function.parameters,
                        webhook: gateway.webhook,
                        originalName: tool.function.name
                    });
                }
            }
        }

        // Remove tools that disappeared or whose definition changed; a tool can
        // keep its name while its schema, description or webhook changes, and
        // clients must not keep validating against the old schema.
        for (const [name, entry] of this.registered) {
            const definition = desired.get(name);
            if (!definition || fingerprintOf(definition) !== entry.fingerprint) {
                entry.handle.remove();
                this.registered.delete(name);
            }
        }
        for (const [name, definition] of desired) {
            if (this.registered.has(name)) continue;
            const handle = this.server.registerTool(name, {
                title: definition.originalName.split('_').slice(1).join('_') || definition.originalName,
                description: definition.description,
                inputSchema: jsonSchemaToZod(definition.parameters || { type: 'object' }) as never,
                annotations: { openWorldHint: true }
            }, safeHandler(async (args: Record<string, unknown>) => {
                const result = await this.client.callGatewayTool(
                    definition.webhook, definition.originalName, args);
                return textResult(result ?? 'Tool executed.');
            }) as never);
            this.registered.set(name, { handle, fingerprint: fingerprintOf(definition) });
        }

        this.pluginMissingLogged = false;
        this.log(`MCP Gateway tools: ${this.registered.size} registered.`);
        return true;
    }

    private disable(reason: string): void {
        this.disabled = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.recheckTimer);
        this.eventSource?.close();
        this.eventSource = undefined;
        this.log(`MCP Gateway tools disabled: ${reason}. API tools keep working.`);
    }

    private scheduleRefresh(): void {
        if (this.stopped || this.disabled) return;
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refresh().catch(err => this.log('Gateway refresh failed.', err));
        }, REFRESH_DEBOUNCE_MS);
        this.refreshTimer.unref?.();
    }

    /** Periodically re-check a tenant that does not (yet) have the plugin installed. */
    private schedulePluginRecheck(): void {
        if (this.stopped || this.disabled) return;
        clearTimeout(this.recheckTimer);
        this.recheckTimer = setTimeout(() => {
            this.start().catch(err => this.log('Gateway plugin re-check failed.', err));
        }, PLUGIN_RECHECK_DELAY_MS);
        this.recheckTimer.unref?.();
    }

    private async connectEvents(): Promise<void> {
        if (this.stopped || this.disabled) return;
        let token: string;
        try {
            token = await this.client.ensureToken();
        } catch (err) {
            this.log('Cannot obtain token for gateway event stream.', err);
            this.scheduleReconnect();
            return;
        }
        // stop()/disable() may have landed while the token round-trip was in
        // flight; without this check the stream below would outlive the manager.
        if (this.stopped || this.disabled) return;

        // NOTE: the mcptools /events endpoint only accepts the JWT as a query
        // parameter (EventSource limitation on the plugin side). Tracked as a
        // known issue in docs/mcptools-endpoints.md.
        const url = `${this.client.baseUrl}/plugins/appmixer/ai/mcptools/events?token=${encodeURIComponent(token)}`;
        this.eventSource?.close();
        const eventSource = new EventSource(url);
        this.eventSource = eventSource;

        eventSource.addEventListener('open', () => {
            this.reconnectAttempts = 0;
        });
        eventSource.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data) as { type?: string };
                if (data.type === 'gateway-add' || data.type === 'gateway-delete') {
                    this.scheduleRefresh();
                }
            } catch {
                // Ignore malformed events.
            }
        });
        eventSource.addEventListener('error', () => {
            if (this.eventSource !== eventSource) return; // Superseded by a newer stream.
            eventSource.close();
            this.eventSource = undefined;
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.disabled) return;
        // Exponential backoff so a stream that keeps failing (expired token,
        // tenant outage) cannot hammer the API for the session's lifetime.
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
            RECONNECT_MAX_DELAY_MS);
        this.reconnectAttempts++;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            // Re-sync missed events, then reconnect with a fresh token.
            this.refresh()
                .then(available => available ? this.connectEvents() : undefined)
                .catch(err => this.log('Gateway event stream reconnect failed.', err));
        }, delay);
        this.reconnectTimer.unref?.();
    }
}

export function sanitizeToolName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return sanitized.slice(0, MAX_TOOL_NAME_LENGTH) || 'tool';
}

export function uniqueName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
        const suffix = `_${i}`;
        const candidate = name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
        if (!taken.has(candidate)) return candidate;
    }
}
