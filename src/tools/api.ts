import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { safeHandler, textResult, truncate } from '../format.js';

const FLOW_ID = z.string().min(1).describe('The ID of the flow.');

export function registerApiTools(server: McpServer, client: AppmixerClient): void {

    server.registerTool('list_flows', {
        title: 'List Flows',
        description: 'List Appmixer flows of the authenticated user, sorted by last modification. ' +
            'Returns flow IDs, names, stages and modification times. Use `pattern` to filter by name.',
        inputSchema: {
            pattern: z.string().optional().describe('Filter flows whose name matches this pattern.'),
            limit: z.number().int().min(1).max(100).default(20)
                .describe('Maximum number of flows to return.'),
            offset: z.number().int().min(0).default(0).describe('Pagination offset.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ pattern, limit, offset }) => {
        const flows = await client.getFlows({ pattern, limit, offset });
        const rows = flows.map(flow => ({
            flowId: flow.flowId,
            name: flow.name,
            stage: flow.stage,
            updated: typeof flow.mtime === 'number' ? new Date(flow.mtime).toISOString() : flow.mtime
        }));
        return textResult({
            count: rows.length,
            offset,
            note: rows.length === limit ? 'More flows may exist; increase offset to page.' : undefined,
            flows: rows
        });
    }));

    server.registerTool('get_flow', {
        title: 'Get Flow',
        description: 'Get a single Appmixer flow by ID: metadata and, optionally, the full flow ' +
            'descriptor (the JSON definition of components and their wiring). ' +
            'Set include_descriptor=true when you need component IDs, e.g. for trigger_component.',
        inputSchema: {
            id: FLOW_ID,
            include_descriptor: z.boolean().default(false)
                .describe('Include the full flow descriptor JSON (can be large).')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, include_descriptor }) => {
        const flow = await client.getFlow(id);
        const result: Record<string, unknown> = {
            flowId: flow.flowId,
            name: flow.name,
            description: flow.description,
            stage: flow.stage,
            type: flow.type,
            created: typeof flow.btime === 'number' ? new Date(flow.btime).toISOString() : flow.btime,
            updated: typeof flow.mtime === 'number' ? new Date(flow.mtime).toISOString() : flow.mtime
        };
        if (include_descriptor) {
            result.descriptor = flow.flow;
        } else {
            const descriptor = (flow.flow || {}) as Record<string, { type?: string; label?: string }>;
            result.components = Object.entries(descriptor).map(([componentId, component]) => ({
                componentId,
                type: component.type,
                label: component.label
            }));
        }
        return textResult(result);
    }));

    server.registerTool('get_flow_status', {
        title: 'Get Flow Status',
        description: 'Get the current stage of an Appmixer flow: "running" or "stopped".',
        inputSchema: { id: FLOW_ID },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id }) => {
        const flow = await client.getFlow(id);
        return textResult({ flowId: flow.flowId, name: flow.name, stage: flow.stage });
    }));

    server.registerTool('get_flow_logs', {
        title: 'Get Flow Logs',
        description: 'Get execution logs of an Appmixer flow. Optionally filter with an Apache Lucene ' +
            'query over fields such as "msg", "@timestamp", "portType", "port", "correlationId", ' +
            '"senderType", "senderId" and "inputMessages".',
        inputSchema: {
            id: FLOW_ID,
            query: z.string().optional().describe('Apache Lucene query to filter the logs.'),
            size: z.number().int().min(1).max(100).default(20)
                .describe('Maximum number of log records to return.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, query, size }) => {
        const logs = await client.getLogs(id, { query, size });
        const hits = (logs.hits || []).map(hit => ({
            timestamp: hit['@timestamp'],
            severity: hit.severity,
            componentId: hit.componentId,
            componentType: hit.componentType,
            port: hit.port,
            portType: hit.portType,
            correlationId: hit.correlationId,
            message: typeof hit.msg === 'string' ? truncate(hit.msg, 500) : hit.msg
        }));
        return textResult({ count: hits.length, logs: hits });
    }));

    server.registerTool('list_unprocessed_messages', {
        title: 'List Unprocessed Messages',
        description: 'List messages that failed processing and were parked instead of being ' +
            'dropped. This is where a component sends its failures under the default error ' +
            'handling ("Stop execution" / onError: storeUnprocessed) — the flow keeps running ' +
            'and the failed message waits here. Use it to find out what broke and, after the ' +
            'flow is fixed, replay it with retry_unprocessed_message.',
        inputSchema: {
            flow_id: z.string().optional().describe('Only messages of this flow.'),
            correlation_id: z.string().optional()
                .describe('Only messages of one flow execution (see get_flow_logs).'),
            limit: z.number().int().min(1).max(100).default(20),
            offset: z.number().int().min(0).default(0)
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ flow_id, correlation_id, limit, offset }) => {
        const messages = await client.getUnprocessedMessages({
            flowId: flow_id, correlationId: correlation_id, limit, offset
        });
        const rows = messages.map(message => {
            // `err` is a JSON string with message/code/name/stack; surface the
            // useful part and keep the stack out of the listing.
            let error: unknown = message.err;
            if (typeof message.err === 'string') {
                try {
                    const parsed = JSON.parse(message.err) as Record<string, unknown>;
                    error = { message: parsed.message, code: parsed.code, name: parsed.name };
                } catch {
                    error = truncate(message.err, 300);
                }
            }
            return {
                messageId: message.messageId,
                flowId: message.flowId,
                componentId: message.componentId,
                correlationId: message.correlationId,
                created: message.created,
                target: message.target,
                error
            };
        });
        return textResult({
            count: rows.length,
            note: rows.length
                ? 'Read one with get_unprocessed_message to see the input that failed.'
                : undefined,
            messages: rows
        });
    }));

    server.registerTool('get_unprocessed_message', {
        title: 'Get Unprocessed Message',
        description: 'Read one parked message in full: `err` (message, code, name, stack) and ' +
            '`messages`, the input the component received keyed by inPort — together they ' +
            'usually explain why it failed.',
        inputSchema: {
            message_id: z.string().min(1).describe('The ID of the message (see list_unprocessed_messages).')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ message_id }) => {
        const message = await client.getUnprocessedMessage(message_id);
        // `err` arrives as a JSON string; parse it so the caller does not have to.
        if (typeof message.err === 'string') {
            try {
                message.err = JSON.parse(message.err);
            } catch { /* leave the raw string */ }
        }
        return textResult(message);
    }));

    server.registerTool('retry_unprocessed_message', {
        title: 'Retry Unprocessed Message',
        description: 'Replay a parked message through its component. Fix the flow first — a ' +
            'replay repeats the original input, so an unfixed cause fails again.',
        inputSchema: {
            message_id: z.string().min(1).describe('The ID of the message to replay.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ message_id }) => {
        const result = await client.retryUnprocessedMessage(message_id);
        return textResult(result ?? `Message ${message_id} queued for retry.`);
    }));

    server.registerTool('delete_unprocessed_message', {
        title: 'Delete Unprocessed Message',
        description: 'Discard a parked message without replaying it. This cannot be undone.',
        inputSchema: {
            message_id: z.string().min(1).describe('The ID of the message to discard.')
        },
        annotations: { destructiveHint: true }
    }, safeHandler(async ({ message_id }) => {
        await client.deleteUnprocessedMessage(message_id);
        return textResult(`Message ${message_id} discarded.`);
    }));

    server.registerTool('start_flow', {
        title: 'Start Flow',
        description: 'Start an Appmixer flow by ID. The flow must be valid and complete to start.',
        inputSchema: { id: FLOW_ID },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ id }) => {
        await client.commandFlow(id, 'start');
        const flow = await client.getFlow(id);
        return textResult({ message: `Flow ${id} start requested.`, stage: flow.stage });
    }));

    server.registerTool('stop_flow', {
        title: 'Stop Flow',
        description: 'Stop a running Appmixer flow by ID.',
        inputSchema: { id: FLOW_ID },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ id }) => {
        await client.commandFlow(id, 'stop');
        const flow = await client.getFlow(id);
        return textResult({ message: `Flow ${id} stop requested.`, stage: flow.stage });
    }));

    server.registerTool('delete_flow', {
        title: 'Delete Flow',
        description: 'Permanently delete an Appmixer flow by ID. This cannot be undone.',
        inputSchema: { id: FLOW_ID },
        annotations: { destructiveHint: true }
    }, safeHandler(async ({ id }) => {
        await client.deleteFlow(id);
        return textResult(`Flow ${id} deleted.`);
    }));

    server.registerTool('trigger_component', {
        title: 'Trigger Component',
        description: 'Send a webhook request that submits data to a trigger component of a running ' +
            'flow, using POST (default), PUT, PATCH or DELETE — match the method the flow\'s webhook ' +
            'trigger expects. Find the component ID with get_flow (include_descriptor=false lists ' +
            'components with their IDs). For triggers that expect GET, use read_component_trigger.',
        inputSchema: {
            flow_id: FLOW_ID,
            component_id: z.string().min(1).describe('The ID of the component to trigger.'),
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).default('POST')
                .describe('HTTP method the webhook trigger listens on.'),
            body: z.record(z.string(), z.unknown()).optional()
                .describe('JSON body to send to the component.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ flow_id, component_id, method, body }) => {
        const result = await client.triggerComponent(flow_id, component_id, { method, body });
        return textResult(result ?? 'Component triggered.');
    }));

    server.registerTool('read_component_trigger', {
        title: 'Read From Component Trigger',
        description: 'Send a GET request to a trigger component of a running flow, for webhook ' +
            'triggers that listen on GET, and return the component\'s response.',
        inputSchema: {
            flow_id: FLOW_ID,
            component_id: z.string().min(1).describe('The ID of the component to call.'),
            query: z.record(z.string(), z.string()).optional()
                .describe('Query string parameters to send with the request.')
        },
        annotations: { readOnlyHint: true, openWorldHint: true }
    }, safeHandler(async ({ flow_id, component_id, query }) => {
        const result = await client.triggerComponent(flow_id, component_id, { method: 'GET', query });
        return textResult(result ?? 'Component called.');
    }));

    server.registerTool('send_app_event', {
        title: 'Send App Event',
        description: 'Send a named App Event to Appmixer. All running flows of this user that contain ' +
            'an OnAppEvent trigger for this event name will receive it.',
        inputSchema: {
            event: z.string().min(1).describe('The name of the event.'),
            data: z.record(z.string(), z.unknown()).optional().describe('Event payload.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ event, data }) => {
        const result = await client.sendAppEvent(event, data);
        return textResult(result ?? `App event "${event}" sent.`);
    }));
}
