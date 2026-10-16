import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAppmixerServer } from '../src/server.js';
import { mintComponentIds } from '../src/tools/authoring.js';
import { loadConfig } from '../src/config.js';
import { futureJwt, jsonResponse } from './helpers.js';

const BASE_URL = 'https://api.tenant.appmixer.cloud';

const MANIFESTS = [
    {
        name: 'appmixer.utils.email.SendEmail',
        description: 'Send an email.',
        icon: 'data:image/svg;base64,xxxxxxxx',
        author: 'Appmixer',
        inPorts: [{ name: 'in', schema: { type: 'object', required: ['to'] } }],
        outPorts: [{ name: 'out' }]
    },
    {
        name: 'appmixer.utils.timers.Scheduler',
        description: 'Fire on schedule.',
        outPorts: [{ name: 'out' }]
    }
];

async function connectedClient() {
    const config = loadConfig({
        APPMIXER_BASE_URL: BASE_URL,
        APPMIXER_ACCESS_TOKEN: futureJwt(),
        TOOLS: 'api'
    });
    const app = createAppmixerServer(config, () => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([app.server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as { text: string }[])[0].text;
}

describe('authoring tools', () => {

    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('get_flow_authoring_guide returns the embedded guide', async () => {
        const client = await connectedClient();
        const result = await client.callTool({ name: 'get_flow_authoring_guide', arguments: {} });
        const text = firstText(result);
        expect(text).toContain('# Appmixer Flow Authoring Guide');
        expect(text).toContain('json2new');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exposes the guide as an MCP resource too', async () => {
        const client = await connectedClient();
        const { resources } = await client.listResources();
        expect(resources.map(r => r.uri)).toContain('appmixer://guides/flow-authoring');
        const read = await client.readResource({ uri: 'appmixer://guides/flow-authoring' });
        expect((read.contents[0] as { text: string }).text).toContain('# Appmixer Flow Authoring Guide');
    });

    it('get_components returns a compact summary without a component argument', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(MANIFESTS));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_components', arguments: { app: 'appmixer.utils' }
        });

        const text = firstText(result);
        expect(text).toContain('"appmixer.utils.email.SendEmail"');
        expect(text).toContain('"trigger": true');   // Scheduler has no inPorts.
        expect(text).not.toContain('base64');        // No icons in summaries.
        expect(text).not.toContain('"schema"');      // No full schemas in summaries.
    });

    it('get_components returns the full manifest without icon for a single component', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(MANIFESTS));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_components',
            arguments: { app: 'appmixer.utils', component: 'appmixer.utils.email.SendEmail' }
        });

        const text = firstText(result);
        expect(text).toContain('"required"');
        expect(text).not.toContain('base64');
    });

    it('create_flow posts the descriptor and reports validation errors', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (String(url).endsWith('/flows') && init?.method === 'POST') {
                return Promise.resolve(jsonResponse({ flowId: 'new-flow' }));
            }
            if (String(url).includes('/validate')) {
                return Promise.resolve(jsonResponse({
                    errors: [{ componentId: 'c1', errors: [{ message: 'Input field "to" is required.' }] }]
                }));
            }
            return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500));
        });
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'create_flow',
            arguments: {
                name: 'Test',
                flow: { 'aaaa-bbbb': { type: 'appmixer.utils.timers.Scheduler', source: {} } }
            }
        });

        const text = firstText(result);
        expect(result.isError).toBeFalsy();
        expect(text).toContain('"flowId": "new-flow"');
        expect(text).toContain('"valid": false');
        expect(text).toContain('Input field \\"to\\" is required.');
    });

    it('mints UUIDs for placeholder component keys and rewrites every reference', async () => {
        const flow = {
            trigger: { type: 'appmixer.utils.appevents.OnAppEvent', source: {} },
            set_var: {
                type: 'appmixer.utils.controls.SetVariable',
                source: { in: { trigger: ['out'] } },
                config: {
                    transform: {
                        in: {
                            trigger: {
                                out: {
                                    type: 'json2new',
                                    modifiers: { variables: { m1: { variable: '$.trigger.out.data.msg' } } },
                                    lambda: { variables: { ADD: [{ text: '{{{m1}}}' }] } }
                                }
                            }
                        }
                    }
                }
            }
        };

        const { flow: minted, minted: map } = mintComponentIds(flow);

        const [triggerId, setVarId] = [map.trigger, map.set_var];
        expect(triggerId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Object.keys(minted).sort()).toEqual([triggerId, setVarId].sort());
        // References follow the rename: source keys and the variable path.
        expect(minted[setVarId].source).toEqual({ in: { [triggerId]: ['out'] } });
        expect(JSON.stringify(minted)).toContain(`$.${triggerId}.out.data.msg`);
        expect(JSON.stringify(minted)).not.toContain('"trigger"');
        // The modifier id is not a component key, so it stays untouched.
        expect(JSON.stringify(minted)).toContain('{{{m1}}}');
    });

    it('leaves existing UUID component keys alone', async () => {
        const id = '11111111-2222-4333-8444-555555555555';
        const { flow, minted } = mintComponentIds({
            [id]: { type: 'appmixer.utils.controls.SetVariable', source: {} }
        });
        expect(minted).toEqual({});
        expect(Object.keys(flow)).toEqual([id]);
    });

    it('create_flow refuses component types that do not exist on the tenant', async () => {
        fetchMock.mockResolvedValue(jsonResponse(MANIFESTS)); // /apps/components
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'create_flow',
            arguments: {
                name: 'Bogus',
                flow: { trigger: { type: 'appmixer.system.trigger.OnAppEvent', source: {} } }
            }
        });

        const text = firstText(result);
        expect(text).toContain('Unknown component types');
        expect(text).toContain('appmixer.system.trigger.OnAppEvent');
        // Nothing was created.
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('reports a failed validation call as invalid instead of shrugging', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (String(url).includes('/apps/components')) return Promise.resolve(jsonResponse(MANIFESTS));
            if (String(url).endsWith('/flows') && init?.method === 'POST') {
                return Promise.resolve(jsonResponse({ flowId: 'f1' }));
            }
            return Promise.resolve(jsonResponse({ message: 'boom' }, 500)); // /validate
        });
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'create_flow',
            arguments: {
                name: 'Test',
                flow: { trigger: { type: 'appmixer.utils.timers.Scheduler', source: {} } }
            }
        });

        const text = firstText(result);
        expect(text).toContain('"valid": false');
        expect(text).toContain('500');
        expect(text).toContain('every component `type` exists');
    });

    it('create_flow rejects descriptors with invalid component types before hitting the API', async () => {
        const client = await connectedClient();
        const result = await client.callTool({
            name: 'create_flow',
            arguments: { name: 'Bad', flow: { c1: { type: 'not-a-type' } } }
        });
        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('get_flow_variables flattens variable paths with schemas', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            components: {
                'trigger-1': {},
                'action-1': {
                    links: {
                        in: {
                            'trigger-1': {
                                out: {
                                    variables: {
                                        dynamic: [
                                            {
                                                componentId: 'trigger-1', label: 'Data', port: 'out',
                                                value: '{{{$.trigger-1.out.data}}}',
                                                schema: { type: 'object', properties: { msg: { type: 'string' } } }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }));
        const client = await connectedClient();

        const result = await client.callTool({ name: 'get_flow_variables', arguments: { id: 'f1' } });

        const text = firstText(result);
        expect(text).toContain('"path": "$.trigger-1.out.data"');
        expect(text).toContain('"availableTo": "action-1"');
        expect(text).toContain('$.trigger-1.out.data.msg (string)'); // Schema expanded to leaf paths.
        expect(text).not.toContain('"path": "{{{'); // Paths are unwrapped from placeholders.
    });

    it('test_flow parses the SSE result stream into outputs', async () => {
        const sse = [
            'event: test:start\ndata: {"testRunId":"t1"}\n\n',
            'event: component:output\ndata: {"componentId":"c1","port":"out","data":{"msg":"direct"}}\n\n',
            'event: component:done\ndata: {"componentId":"c1"}\n\n',
            'event: test:done\ndata: {"testRunId":"t1","status":"completed"}\n\n'
        ].join('');
        fetchMock.mockResolvedValueOnce(new Response(sse, {
            status: 200, headers: { 'Content-Type': 'text/event-stream' }
        }));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'test_flow',
            arguments: { id: 'f1', component_id: 'c1', input_data: { in: { msg: 'direct' } } }
        });

        const text = firstText(result);
        expect(result.isError).toBeFalsy();
        expect(text).toContain('"status": "completed"');
        expect(text).toContain('"msg": "direct"');
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body)).toMatchObject({
            componentId: 'c1',
            inputData: { in: { msg: 'direct' } }
        });
    });

    it('test_flow reports a server-side test:error as an error, not a timeout', async () => {
        const sse = 'event: test:error\ndata: {"message":"Unknown componentId"}\n\n';
        fetchMock.mockResolvedValueOnce(new Response(sse, {
            status: 200, headers: { 'Content-Type': 'text/event-stream' }
        }));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'test_flow', arguments: { id: 'f1', component_id: 'nope' }
        });

        const text = firstText(result);
        expect(text).toContain('"status": "error"');
        expect(text).toContain('Unknown componentId');
        expect(text).not.toContain('timeout');
    });

    it('test_flow parses CRLF event streams', async () => {
        const sse = 'event: component:output\r\ndata: {"componentId":"c1","port":"out","data":{"ok":true}}\r\n\r\n'
            + 'event: test:done\r\ndata: {"status":"completed"}\r\n\r\n';
        fetchMock.mockResolvedValueOnce(new Response(sse, {
            status: 200, headers: { 'Content-Type': 'text/event-stream' }
        }));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'test_flow', arguments: { id: 'f1', component_id: 'c1' }
        });

        const text = firstText(result);
        expect(text).toContain('"status": "completed"');
        expect(text).toContain('"ok": true');
    });

    it('get_component_options POSTs to the component function endpoint', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([
            { label: 'item.sku', value: 'value.sku' }
        ]));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_component_options',
            arguments: {
                component_type: 'appmixer.utils.controls.Each',
                component_id: 'comp-1',
                out_port: 'item',
                messages: { in: { list: [{ sku: 'X1' }] } }
            }
        });

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain('value.sku');
        expect(firstText(result)).toContain('"count": 1');
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/component/appmixer/utils/controls/Each?outPort=item');
        expect(JSON.parse(init.body)).toEqual({
            componentId: 'comp-1',
            messages: { in: { list: [{ sku: 'X1' }] } }
        });
    });

    it('get_component_options rejects malformed component types before calling the API', async () => {
        const client = await connectedClient();
        const result = await client.callTool({
            name: 'get_component_options',
            arguments: { component_type: 'not-a-type', component_id: 'c1' }
        });
        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('get_trigger_url GETs the trigger url endpoint', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ response: 'https://api.tenant/flows/f1/components/c1' }));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_trigger_url', arguments: { flow_id: 'f1', component_id: 'c1' }
        });

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain('/flows/f1/components/c1');
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/triggers/c1/url');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('get_trigger_url falls back to the constructed URL when the endpoint 500s', async () => {
        // Current platform versions 500 on /triggers/:id/url (missing return in
        // the route's pre-step); the deterministic URL keeps the tool useful.
        fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'method method did not return a value' }, 500));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_trigger_url', arguments: { flow_id: 'f1', component_id: 'c1' }
        });

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain(`${BASE_URL}/flows/f1/components/c1`);
    });

    it('assign_account PUTs to the auth component endpoint', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'assign_account', arguments: { component_id: 'c1', account_id: 'a1' }
        });

        expect(result.isError).toBeFalsy();
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/auth/component/c1/a1');
        expect(init.method).toBe('PUT');
    });

    it('validate_flow reports success for a clean flow', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [] }));
        const client = await connectedClient();
        const result = await client.callTool({ name: 'validate_flow', arguments: { id: 'f1' } });
        expect(firstText(result)).toContain('"valid": true');
    });
});
