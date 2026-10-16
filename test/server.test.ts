import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAppmixerServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { futureJwt, jsonResponse } from './helpers.js';

const BASE_URL = 'https://api.tenant.appmixer.cloud';

async function connectedClient(tools = 'api') {
    const config = loadConfig({
        APPMIXER_BASE_URL: BASE_URL,
        APPMIXER_ACCESS_TOKEN: futureJwt(),
        TOOLS: tools
    });
    const app = createAppmixerServer(config, () => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
        app.server.connect(serverTransport),
        client.connect(clientTransport)
    ]);
    return { client, app };
}

describe('appmixer MCP server', () => {

    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists API tools with titles and correct annotations', async () => {
        const { client } = await connectedClient();
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));

        expect(Object.keys(byName).sort()).toEqual([
            'assign_account', 'clone_flow', 'create_flow', 'create_flow_version',
            'create_store', 'delete_flow', 'delete_store_record',
            'delete_unprocessed_message', 'get_component_options', 'get_components',
            'get_flow', 'get_flow_accounts', 'get_flow_authoring_guide', 'get_flow_logs',
            'get_flow_status', 'get_flow_variables', 'get_store_records',
            'get_trigger_url', 'get_unprocessed_message', 'list_accounts', 'list_apps',
            'list_flow_versions', 'list_flows', 'list_modifiers', 'list_stores',
            'list_unprocessed_messages', 'read_component_trigger', 'restore_flow_version',
            'retry_unprocessed_message', 'send_app_event', 'set_store_record',
            'start_flow', 'stop_flow', 'test_flow', 'trigger_component', 'update_flow',
            'validate_flow'
        ]);
        expect(byName.list_flows.annotations?.readOnlyHint).toBe(true);
        expect(byName.delete_flow.annotations?.destructiveHint).toBe(true);
        expect(byName.start_flow.annotations?.destructiveHint).toBe(false);
        // Read and write webhook calls are separate tools; neither mixes safe
        // and unsafe HTTP methods.
        expect(byName.read_component_trigger.annotations?.readOnlyHint).toBe(true);
        expect(byName.trigger_component.inputSchema.properties?.method)
            .toMatchObject({ enum: ['POST', 'PUT', 'PATCH', 'DELETE'] });
        for (const tool of tools) {
            expect(tool.name.length).toBeLessThanOrEqual(64);
            expect(tool.annotations?.title || (tool as { title?: string }).title).toBeTruthy();
            expect(tool.description).toBeTruthy();
        }
    });

    it('list_flows returns compact rows', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([
            { flowId: 'f1', name: 'Flow One', stage: 'running', mtime: 1755000000000, thumbnailIgnored: 'x' }
        ]));
        const { client } = await connectedClient();

        const result = await client.callTool({ name: 'list_flows', arguments: {} });

        const text = (result.content as { text: string }[])[0].text;
        expect(result.isError).toBeFalsy();
        expect(text).toContain('"flowId": "f1"');
        expect(text).toContain('"stage": "running"');
        expect(text).not.toContain('thumbnailIgnored');
    });

    it('propagates API failures as actionable isError results', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Flow not found.' }, 404));
        const { client } = await connectedClient();

        const result = await client.callTool({ name: 'get_flow', arguments: { id: 'missing' } });

        expect(result.isError).toBe(true);
        const text = (result.content as { text: string }[])[0].text;
        expect(text).toContain('404');
        expect(text).toContain('Flow not found.');
        expect(text).toContain('Check that the ID is correct');
    });

    it('trigger_component honours non-POST webhook methods', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const { client } = await connectedClient();

        await client.callTool({
            name: 'trigger_component',
            arguments: { flow_id: 'f1', component_id: 'c1', method: 'PUT', body: { a: 1 } }
        });

        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/flows/f1/components/c1');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ a: 1 });
    });

    it('read_component_trigger sends a GET with query parameters and no body', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const { client } = await connectedClient();

        await client.callTool({
            name: 'read_component_trigger',
            arguments: { flow_id: 'f1', component_id: 'c1', query: { token: 'x' } }
        });

        const [url, init] = fetchMock.mock.calls[0];
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(String(url)).toContain('token=x');
    });

    it('validates tool input before calling the API', async () => {
        const { client } = await connectedClient();
        const result = await client.callTool({ name: 'get_flow', arguments: {} });
        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('list_unprocessed_messages surfaces the parsed error without the stack', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([{
            messageId: 'm1', flowId: 'f1', componentId: 'c1',
            correlationId: ['corr-1'], created: '2026-08-21T13:36:16.049Z', target: 'input-queue',
            err: JSON.stringify({
                message: 'getaddrinfo ENOTFOUND example.invalid',
                code: 'APPMIXER_ERR_MAX_RETRY_COUNT_EXCEEDED',
                name: 'MaximumRetryCountExceeded',
                stack: 'MaximumRetryCountExceeded: getaddrinfo…'
            }),
            messages: { in: [{ properties: {}, content: {} }] }
        }]));
        const { client } = await connectedClient();

        const result = await client.callTool({
            name: 'list_unprocessed_messages', arguments: { flow_id: 'f1' }
        });

        const text = (result.content as { text: string }[])[0].text;
        expect(text).toContain('"messageId": "m1"');
        expect(text).toContain('ENOTFOUND example.invalid');
        expect(text).toContain('MaximumRetryCountExceeded');
        // Listings stay compact: no stack trace and no message payload, both of
        // which belong in the detail call.
        expect(text).not.toContain('stack');
        expect(text).not.toContain('"properties"');
    });

    it('retry_unprocessed_message POSTs to the retry endpoint', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}));
        const { client } = await connectedClient();

        await client.callTool({ name: 'retry_unprocessed_message', arguments: { message_id: 'm1' } });

        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/unprocessed-messages/m1/retry');
        expect(init.method).toBe('POST');
    });

    it('propagates client cancellation to the upstream request', async () => {
        let upstreamSignal: AbortSignal | undefined;
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            upstreamSignal = init.signal as AbortSignal;
            // Never settles on its own: only the abort ends this call.
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        });
        const { client } = await connectedClient();

        const controller = new AbortController();
        const call = client.callTool({ name: 'list_flows', arguments: {} }, undefined, {
            signal: controller.signal
        });
        await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
        expect(upstreamSignal!.aborted).toBe(false);

        controller.abort();
        await call.catch(() => undefined); // The client rejects its own request.
        // The tool handler's signal reached the HTTP layer, so the upstream
        // request was torn down instead of running to completion.
        await vi.waitFor(() => expect(upstreamSignal!.aborted).toBe(true));
    });

    it('registers gateway tools from the mcptools plugin and calls them via webhook', async () => {
        const webhook = `${BASE_URL}/flows/flow-1/components/comp-1`;
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (String(url).includes('/mcptools/gateways')) {
                return Promise.resolve(jsonResponse([{
                    flowId: 'flow-1', componentId: 'comp-1', webhook,
                    tools: [{
                        type: 'function',
                        function: {
                            name: 'abc123_send_email',
                            description: 'Send an email.',
                            parameters: {
                                type: 'object',
                                properties: { to: { type: 'string' } },
                                required: ['to']
                            }
                        }
                    }]
                }]));
            }
            if (String(url) === webhook && init?.method === 'POST') {
                return Promise.resolve(jsonResponse('sent'));
            }
            return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500));
        });

        const { client, app } = await connectedClient('api,mcpgateway');
        await app.gatewayManager!.refresh();

        const { tools } = await client.listTools();
        const gatewayTool = tools.find(tool => tool.name === 'abc123_send_email');
        expect(gatewayTool).toBeDefined();
        expect(gatewayTool!.inputSchema.properties).toHaveProperty('to');

        const result = await client.callTool({
            name: 'abc123_send_email',
            arguments: { to: 'x@example.com' }
        });
        expect(result.isError).toBeFalsy();
        expect((result.content as { text: string }[])[0].text).toBe('sent');

        const webhookCall = fetchMock.mock.calls.find(([url]) => String(url) === webhook);
        expect(JSON.parse(webhookCall![1].body)).toEqual({
            function: { name: 'abc123_send_email', arguments: { to: 'x@example.com' } }
        });
    });

    it('disables gateway tools gracefully when the plugin is missing', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404));
        const { client, app } = await connectedClient('api,mcpgateway');

        await expect(app.gatewayManager!.refresh()).resolves.toBe(false);
        const { tools } = await client.listTools();
        expect(tools.length).toBe(37); // API + authoring tools only, no crash.
    });

    it('re-registers a gateway tool whose schema changed under the same name', async () => {
        const webhook = `${BASE_URL}/flows/flow-1/components/comp-1`;
        const gatewayWith = (properties: Record<string, unknown>) => [{
            flowId: 'flow-1', componentId: 'comp-1', webhook,
            tools: [{
                type: 'function',
                function: {
                    name: 'abc123_tool', description: 'A tool.',
                    parameters: { type: 'object', properties }
                }
            }]
        }];
        fetchMock.mockResolvedValueOnce(jsonResponse(gatewayWith({ old: { type: 'string' } })));
        const { client, app } = await connectedClient('api,mcpgateway');
        await app.gatewayManager!.refresh();

        fetchMock.mockResolvedValueOnce(jsonResponse(gatewayWith({ renewed: { type: 'number' } })));
        await app.gatewayManager!.refresh();

        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'abc123_tool');
        expect(tool!.inputSchema.properties).toHaveProperty('renewed');
        expect(tool!.inputSchema.properties).not.toHaveProperty('old');
    });

    it('disables gateway polling permanently when the tenant rejects the credentials', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401));
        const { app } = await connectedClient('api,mcpgateway');

        await expect(app.gatewayManager!.refresh()).resolves.toBe(false);
        const callsAfterFirst = fetchMock.mock.calls.length;

        // A rejected credential is fatal: further refreshes must not hit the API.
        await expect(app.gatewayManager!.refresh()).resolves.toBe(false);
        expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });
});
