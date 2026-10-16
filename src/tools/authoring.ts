import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { describeError } from '../errors.js';
import { safeHandler, textResult, truncate } from '../format.js';
import { FLOW_AUTHORING_GUIDE } from '../guide.js';

const COMPONENT_TYPE_PATTERN = /^\w+\.\w+\.\w+\.\w+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Descriptor = Record<string, Record<string, unknown>>;

/**
 * Replace component keys that are not UUIDs with freshly minted ones, rewriting
 * every reference to them (source entries, `$.<id>.…` variable paths). Lets a
 * caller use readable placeholders like "trigger" instead of generating UUIDs,
 * which is a surprisingly common way for flow creation to fail. Existing UUID
 * keys are left alone — on an edit they carry the component's identity,
 * including its connected account.
 */
export function mintComponentIds(flow: Descriptor): { flow: Descriptor; minted: Record<string, string> } {
    const minted: Record<string, string> = {};
    for (const key of Object.keys(flow)) {
        if (!UUID_PATTERN.test(key)) minted[key] = randomUUID();
    }
    if (Object.keys(minted).length === 0) return { flow, minted };

    let json = JSON.stringify(flow);
    for (const [placeholder, uuid] of Object.entries(minted)) {
        // Match the ID only as a whole token — bounded by a quote or a dot, which
        // is how IDs appear in the descriptor ("<id>" keys and $.<id>.field paths).
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        json = json.replace(new RegExp(`(?<=["\\.])${escaped}(?=["\\.])`, 'g'), uuid);
    }
    return { flow: JSON.parse(json) as Descriptor, minted };
}

/** Component types in the descriptor that do not exist on this tenant. */
async function unknownComponentTypes(client: AppmixerClient, flow: Descriptor): Promise<string[]> {
    const types = new Set(Object.values(flow)
        .map(component => component.type)
        .filter((type): type is string => typeof type === 'string'));
    const unknown: string[] = [];
    for (const type of types) {
        const app = type.split('.').slice(0, 2).join('.');
        try {
            const known = await client.getComponentNames(app);
            if (!known.has(type)) unknown.push(type);
        } catch {
            // Cannot verify (API error, unknown app): let the platform decide.
        }
    }
    return unknown;
}

/** Flow descriptor: flat map of component UUID -> component descriptor. */
const FLOW_DESCRIPTOR = z.record(
    z.string().describe('Component ID (a fresh UUID v4).'),
    z.looseObject({
        type: z.string().regex(COMPONENT_TYPE_PATTERN,
            'Component type must match vendor.service.module.Component, e.g. appmixer.utils.timers.Scheduler.')
    })
).describe('The flow descriptor JSON: a flat object mapping component UUIDs to component ' +
    'descriptors (type, label, source, config, x, y). See get_flow_authoring_guide.');

interface ComponentManifest {
    name?: string;
    label?: string;
    description?: string;
    inPorts?: { name: string }[];
    outPorts?: { name: string }[];
    [key: string]: unknown;
}

/** Expand an object schema into concrete leaf variable paths: "$.uuid.out.data.msg (string)". */
function flattenSchemaPaths(schema: unknown, basePath: string, depth = 0): string[] | undefined {
    const s = schema as { type?: string; properties?: Record<string, unknown> } | undefined;
    if (!s || s.type !== 'object' || !s.properties || depth >= 3) return undefined;
    const paths: string[] = [];
    for (const [key, property] of Object.entries(s.properties)) {
        const child = property as { type?: string };
        const path = `${basePath}.${key}`;
        const nested = flattenSchemaPaths(child, path, depth + 1);
        if (nested?.length) {
            paths.push(...nested);
        } else {
            paths.push(`${path} (${child.type || 'unknown'})`);
        }
    }
    return paths;
}

async function validationSummary(client: AppmixerClient, flowId: string): Promise<unknown> {
    try {
        const result = await client.validateFlow(flowId);
        const errors = result?.errors || [];
        if (errors.length === 0) return { valid: true };
        const hints = ['Fix the reported errors with update_flow, then run validate_flow again.'];
        if (JSON.stringify(errors).includes('contains invalid variable')) {
            hints.push('"contains invalid variable" means a modifier\'s variable path does not ' +
                'exist in the upstream output — often a missing wrapper object (e.g. OnAppEvent ' +
                'nests the payload under "data": $.<uuid>.out.data.<field>). Call ' +
                'get_flow_variables and copy the exact reported path.');
        }
        return { valid: false, errors, hint: hints.join(' ') };
    } catch (err) {
        // A validation call that fails is itself a problem — most often an
        // unknown component type, which the platform accepts on write and then
        // cannot validate. Report it as invalid rather than as a shrug.
        return {
            valid: false,
            error: describeError(err),
            hint: 'The flow could not be validated. Check that every component `type` exists ' +
                '(get_components) — the platform stores unknown types but cannot validate them.'
        };
    }
}

export function registerAuthoringTools(server: McpServer, client: AppmixerClient): void {

    server.registerTool('get_flow_authoring_guide', {
        title: 'Get Flow Authoring Guide',
        description: 'Get the complete guide to writing Appmixer flow descriptor JSON: structure, ' +
            'wiring (source), input mapping (config.transform, modifiers, variables), error handling ' +
            'and common validation failures. Read this before calling create_flow or update_flow.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safeHandler(async () => {
        return { content: [{ type: 'text' as const, text: FLOW_AUTHORING_GUIDE }] };
    }));

    server.registerTool('list_apps', {
        title: 'List Apps',
        description: 'List apps (connectors) available on this Appmixer tenant, e.g. "appmixer.utils", ' +
            '"appmixer.slack". Use get_components to inspect an app\'s components.',
        inputSchema: {
            category: z.string().optional().describe('Filter by category, e.g. "applications" or "utilities".')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ category }) => {
        const apps = await client.getApps();
        const rows = Object.values(apps)
            .filter(app => !category || app.category === category)
            .map(app => ({
                name: app.name,
                label: app.label,
                category: app.category,
                description: app.description ? truncate(app.description, 120) : undefined
            }));
        return textResult({ count: rows.length, apps: rows });
    }));

    server.registerTool('get_components', {
        title: 'Get Components',
        description: 'Inspect components of an Appmixer app. Without `component`, returns a compact ' +
            'summary of all the app\'s components (type, description, port names). With `component` ' +
            '(the full type, e.g. "appmixer.utils.email.SendEmail"), returns the full manifest ' +
            'including input fields, required fields and output variables — needed to build ' +
            'config.transform correctly. Never guess component types, port names or fields.',
        inputSchema: {
            app: z.string().min(1)
                .describe('App/module name, e.g. "appmixer.utils" or "appmixer.slack" (see list_apps).'),
            component: z.string().optional()
                .describe('Exact component type to get the full manifest for.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ app, component }) => {
        const components = await client.getComponents(app) as ComponentManifest[];
        if (component) {
            const manifest = components.find(c => c.name === component);
            if (!manifest) {
                return textResult({
                    error: `Component "${component}" not found in app "${app}".`,
                    available: components.map(c => c.name)
                });
            }
            // Strip fields irrelevant for authoring to keep the output lean.
            const { icon, author, dependencies, ...essential } = manifest as Record<string, unknown>;
            return textResult(essential, 40_000);
        }
        const rows = components.map(c => ({
            type: c.name,
            description: c.description ? truncate(String(c.description), 150) : undefined,
            trigger: !c.inPorts || c.inPorts.length === 0,
            inPorts: (c.inPorts || []).map(p => p.name),
            outPorts: (c.outPorts || []).map(p => p.name)
        }));
        return textResult({
            count: rows.length,
            note: 'Call get_components with `component` set to a type to get its full manifest.',
            components: rows
        });
    }));

    server.registerTool('list_accounts', {
        title: 'List Accounts',
        description: 'List third-party accounts (Slack, Google, …) connected by the authenticated ' +
            'Appmixer user. Components of connected apps need an account; accounts are connected by ' +
            'the user in the Appmixer UI, not through this server.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safeHandler(async () => {
        const accounts = await client.getAccounts();
        const rows = accounts.map(account => ({
            accountId: account.accountId ?? account.id,
            service: account.service,
            name: account.name ?? account.displayName,
            profile: account.profileInfo
        }));
        return textResult({ count: rows.length, accounts: rows });
    }));

    server.registerTool('create_flow', {
        title: 'Create Flow',
        description: 'Create a new Appmixer flow from a flow descriptor JSON and validate it. ' +
            'Read get_flow_authoring_guide first and discover exact component types, ports and ' +
            'fields with get_components. Component keys may be readable placeholders ("trigger", ' +
            '"send_email") — real UUIDs are minted for them and every reference is rewritten, so ' +
            'you never need to generate IDs yourself; the mapping comes back as `componentIds`. ' +
            'The flow is created stopped; fix any validation errors with update_flow, then ' +
            'use start_flow.',
        inputSchema: {
            name: z.string().min(1).describe('Human-readable flow name.'),
            flow: FLOW_DESCRIPTOR,
            description: z.string().optional().describe('Optional flow description.'),
            custom_fields: z.record(z.string(), z.unknown()).optional()
                .describe('Custom metadata, e.g. {"category": "sales"}; list_flows can filter on these.'),
            stage: z.string().optional().describe('Flow stage, e.g. "draft".')
        },
        annotations: { destructiveHint: false }
    }, safeHandler(async ({ name, flow, description, custom_fields, stage }) => {
        const unknown = await unknownComponentTypes(client, flow as Descriptor);
        if (unknown.length) {
            return textResult({
                error: `Unknown component types: ${unknown.join(', ')}.`,
                hint: 'The platform stores unknown types but cannot run or validate them. ' +
                    'Look the component up with get_components and use its exact `type`.'
            });
        }
        const { flow: descriptor, minted } = mintComponentIds(flow as Descriptor);
        const created = await client.createFlow({
            name, flow: descriptor, description,
            ...(custom_fields ? { customFields: custom_fields } : {}),
            ...(stage ? { stage } : {})
        });
        const validation = await validationSummary(client, created.flowId);
        return textResult({
            flowId: created.flowId,
            componentIds: Object.keys(minted).length ? minted : undefined,
            validation
        });
    }));

    server.registerTool('update_flow', {
        title: 'Update Flow',
        description: 'Update an existing Appmixer flow (descriptor and/or name) and re-validate it. ' +
            'Send the COMPLETE flow descriptor — it replaces the stored one, so start from the ' +
            'current descriptor (get_flow with include_descriptor=true), keep the existing ' +
            'component IDs and the configuration of everything you were not asked to change. ' +
            'A running flow is rejected unless force is set.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow to update.'),
            flow: FLOW_DESCRIPTOR.optional(),
            name: z.string().optional().describe('New flow name.'),
            description: z.string().optional().describe('New flow description.'),
            custom_fields: z.record(z.string(), z.unknown()).optional()
                .describe('Custom metadata; replaces the stored object.'),
            force: z.boolean().default(false)
                .describe('Update even while the flow is running. The change takes effect on the running flow; leave false to be told to stop it first.')
        },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ id, flow, name, description, custom_fields, force }) => {
        const body: Record<string, unknown> = {};
        let minted: Record<string, string> = {};
        if (flow !== undefined) {
            const unknown = await unknownComponentTypes(client, flow as Descriptor);
            if (unknown.length) {
                return textResult({
                    error: `Unknown component types: ${unknown.join(', ')}.`,
                    hint: 'Look the component up with get_components and use its exact `type`.'
                });
            }
            const result = mintComponentIds(flow as Descriptor);
            minted = result.minted;
            body.flow = result.flow;
        }
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (custom_fields !== undefined) body.customFields = custom_fields;
        await client.updateFlow(id, body, { force });
        const validation = await validationSummary(client, id);
        return textResult({
            flowId: id,
            updated: true,
            componentIds: Object.keys(minted).length ? minted : undefined,
            validation
        });
    }));

    server.registerTool('get_flow_variables', {
        title: 'Get Flow Variables',
        description: 'Get the output variables available to each component of a flow — the exact ' +
            '"$.<componentId>.<port>.<field>" paths (with schemas) usable in config.transform ' +
            'modifiers. Call this after create_flow/update_flow to fix or build variable references ' +
            'instead of guessing paths.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            component_id: z.string().optional()
                .describe('Only return variables available to this component.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, component_id }) => {
        const result = await client.fetchFlowVariables(id);
        const components = (result.components || {}) as Record<string, {
            links?: Record<string, Record<string, Record<string, {
                variables?: { dynamic?: { label?: string; port?: string; value?: string; schema?: unknown }[] }
            }>>>
        }>;
        const rows: Record<string, unknown>[] = [];
        for (const [componentId, entry] of Object.entries(components)) {
            if (component_id && componentId !== component_id) continue;
            for (const [inPort, upstreams] of Object.entries(entry.links || {})) {
                for (const [upstreamId, ports] of Object.entries(upstreams)) {
                    for (const [port, portEntry] of Object.entries(ports)) {
                        for (const variable of portEntry.variables?.dynamic || []) {
                            const path = variable.value?.replace(/^\{\{\{|\}\}\}$/g, '');
                            rows.push({
                                availableTo: componentId,
                                inPort,
                                from: upstreamId,
                                port,
                                label: variable.label,
                                path,
                                fields: path ? flattenSchemaPaths(variable.schema, path) : undefined
                            });
                        }
                    }
                }
            }
        }
        return textResult({
            count: rows.length,
            note: 'Use `path` as the "variable" of a modifier entry in config.transform ' +
                '(never inside {{{...}}} placeholders directly).',
            variables: rows
        });
    }));

    server.registerTool('test_flow', {
        title: 'Test Flow',
        description: 'Test-run a single component (and its downstream graph) of a flow without ' +
            'starting the flow. Provide the input data the component should receive; returns the ' +
            'outputs each component produced. The flow does not need to be running. Use this to ' +
            'verify a flow works before start_flow.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            component_id: z.string().min(1)
                .describe('The component to inject test input into (typically the first action after the trigger, or the trigger itself with `payload`).'),
            input_data: z.record(z.string(), z.unknown()).optional()
                .describe('Input for the tested component, keyed by its inPort name, e.g. {"in": {"to": "x@example.com"}}.'),
            payload: z.record(z.string(), z.unknown()).optional()
                .describe('Webhook-style payload when testing a trigger component.'),
            timeout_seconds: z.number().int().min(5).max(120).default(30)
                .describe('How long to wait for the test to finish.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ id, component_id, input_data, payload, timeout_seconds }) => {
        const events = await client.runFlowTest(id, {
            componentId: component_id,
            inputData: input_data,
            payload,
            options: { timeout: timeout_seconds * 1000 }
        }, timeout_seconds * 1000 + 10_000);

        const outputs = events
            .filter(e => e.event === 'component:output')
            .map(e => e.data as Record<string, unknown>)
            .map(d => ({ componentId: d.componentId, port: d.port, data: d.data }));
        const errors = events
            .filter(e => e.event === 'component:error' || e.event === 'test:error')
            .map(e => e.data);

        const doneEvent = events.find(e => e.event === 'test:done');
        const errorEvent = events.find(e => e.event === 'test:error');
        let status: unknown;
        if (doneEvent) {
            status = (doneEvent.data as Record<string, unknown>).status;
        } else if (errorEvent) {
            // The run failed server-side; reporting this as a timeout would send
            // the caller after the wrong fix.
            status = 'error';
        } else if (events.some(e => e.event === 'client:timeout')) {
            status = 'timeout';
        } else {
            status = 'incomplete';
        }
        return textResult({
            status,
            outputs,
            errors: errors.length ? errors : undefined,
            events: events.map(e => e.event)
        });
    }));

    server.registerTool('get_component_options', {
        title: 'Get Component Options',
        description: 'Resolve a field\'s dynamic options at runtime — the values behind inspector ' +
            'fields and output ports whose manifest declares a `source` URL (Slack channel ' +
            'pickers, spreadsheet lists, generated output variables). Take `component_type` and ' +
            '`out_port` from that source URL (it often points at a different, auxiliary ' +
            'component), and pass the component that owns the field as `component_id` — it must ' +
            'already exist in a flow and, for connected services, have an account assigned, ' +
            'because the lookup runs with that component\'s credentials. Results are the ' +
            'auxiliary component\'s raw output: sources that declare a `transform` are not ' +
            'converted here, so pick the identifier the target field expects (Slack channels: ' +
            '`id`). Pointer strings in `source.data` such as "properties/event" mean "send that ' +
            'property\'s value".',
        inputSchema: {
            component_type: z.string().regex(COMPONENT_TYPE_PATTERN)
                .describe('Component type from the source URL, e.g. "appmixer.slack.list.ListChannels".'),
            component_id: z.string().min(1)
                .describe('ID of the component that owns the field, in one of your flows.'),
            out_port: z.string().optional()
                .describe('Output port name from the source URL (its `outPort` query parameter).'),
            properties: z.record(z.string(), z.unknown()).optional()
                .describe('Property values the source expects, e.g. {"generateOutputPortOptions": true}.'),
            messages: z.record(z.string(), z.unknown()).optional()
                .describe('Input messages the source expects, keyed by inPort, e.g. {"in": {"types": "public_channel"}}.'),
            limit: z.number().int().min(1).max(200).default(50)
                .describe('Maximum number of options to return.')
        },
        annotations: { readOnlyHint: true, openWorldHint: true }
    }, safeHandler(async ({ component_type, component_id, out_port, properties, messages, limit }) => {
        const options = await client.callComponentFunction(
            component_type, { componentId: component_id, properties, messages }, out_port);
        if (Array.isArray(options)) {
            return textResult({
                count: options.length,
                note: options.length > limit
                    ? `Showing the first ${limit} of ${options.length}; raise limit to see more.`
                    : undefined,
                options: options.slice(0, limit)
            });
        }
        return textResult(options ?? []);
    }));

    server.registerTool('get_trigger_url', {
        title: 'Get Trigger URL',
        description: 'Get the public webhook URL of a trigger component (e.g. WebhookTrigger) in ' +
            'one of your flows. Use it to chain flows: another flow POSTs to this URL via ' +
            'appmixer.utils.http.Post — no credentials needed, the endpoint is public. The flow ' +
            'must be running for the webhook to actually accept requests.',
        inputSchema: {
            flow_id: z.string().min(1).describe('The ID of the flow the trigger belongs to.'),
            component_id: z.string().min(1).describe('The ID of the trigger component.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ flow_id, component_id }) => {
        try {
            return textResult(await client.getTriggerUrl(component_id));
        } catch {
            // GET /triggers/:componentId/url 500s on current platform versions
            // (missing `return` in the route's pre-step, gridd/routes/trigger.js).
            // The URL is deterministic, so fall back to constructing it.
            return textResult({
                url: `${client.baseUrl}/flows/${encodeURIComponent(flow_id)}/components/${encodeURIComponent(component_id)}`
            });
        }
    }));

    server.registerTool('get_flow_accounts', {
        title: 'Get Flow Accounts',
        description: 'List which components of a flow require a connected third-party account and ' +
            'which account (if any) is assigned to them.',
        inputSchema: { id: z.string().min(1).describe('The ID of the flow.') },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id }) => {
        return textResult(await client.getFlowAccounts(id));
    }));

    server.registerTool('assign_account', {
        title: 'Assign Account',
        description: 'Assign a connected third-party account (see list_accounts) to a component of ' +
            'a flow, so the component can authenticate against its service. The account must belong ' +
            'to the authenticated user and match the component\'s service.',
        inputSchema: {
            component_id: z.string().min(1).describe('The ID of the component (see get_flow).'),
            account_id: z.string().min(1).describe('The ID of the account (see list_accounts).')
        },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ component_id, account_id }) => {
        await client.assignAccount(component_id, account_id);
        return textResult(`Account ${account_id} assigned to component ${component_id}.`);
    }));

    server.registerTool('validate_flow', {
        title: 'Validate Flow',
        description: 'Validate an Appmixer flow server-side. Returns per-component errors (wrong ' +
            'port names, missing required fields, invalid variables). A flow must be valid to start.',
        inputSchema: { id: z.string().min(1).describe('The ID of the flow to validate.') },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id }) => {
        return textResult(await validationSummary(client, id));
    }));
}
