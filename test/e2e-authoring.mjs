// Live E2E: drives the full flow-authoring cycle through the MCP server
// against a real tenant: create -> validate -> start -> app event -> logs ->
// stop -> delete. Requires APPMIXER_* env vars.
// Usage: node test/e2e-authoring.mjs
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: { ...process.env, TOOLS: 'api' },
    stderr: 'inherit'
});
const client = new Client({ name: 'e2e-authoring', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError && !allowError) throw new Error(`${name} failed: ${text}`);
    console.log(`-- ${name}: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
    return text;
};

const EVENT = `mcp-e2e-${Date.now()}`;
const trigger = randomUUID();
const action = randomUUID();
const modifier = randomUUID();

// Discovery must work before authoring.
await call('list_apps', { category: 'utilities' });
await call('get_components', { app: 'appmixer.utils', component: 'appmixer.utils.controls.SetVariable' });

const flow = {
    [trigger]: {
        type: 'appmixer.utils.appevents.OnAppEvent',
        label: 'On E2E event',
        source: {},
        config: { properties: { event: EVENT, eventDataExample: '{"msg": "hello"}' } },
        x: 100, y: 200
    },
    [action]: {
        type: 'appmixer.utils.controls.SetVariable',
        label: 'Set message',
        source: { in: { [trigger]: ['out'] } },
        config: {
            transform: {
                in: {
                    [trigger]: {
                        out: {
                            type: 'json2new',
                            modifiers: {
                                variables: {
                                    [modifier]: { variable: `$.${trigger}.out.data.msg`, functions: [] }
                                }
                            },
                            lambda: {
                                variables: { ADD: [{ name: 'msg', type: 'text', text: `{{{${modifier}}}}` }] }
                            }
                        }
                    }
                }
            }
        },
        x: 300, y: 200
    }
};

let flowId;
try {
    const created = await call('create_flow', { name: `mcp-e2e-authoring-${Date.now()}`, flow });
    flowId = JSON.parse(created).flowId;

    const validation = JSON.parse(await call('validate_flow', { id: flowId }));
    if (validation.valid !== true) throw new Error(`Flow expected valid, got: ${JSON.stringify(validation)}`);

    await call('start_flow', { id: flowId });
    const status = JSON.parse(await call('get_flow_status', { id: flowId }));
    if (status.stage !== 'running') throw new Error(`Expected running, got ${status.stage}`);

    await call('send_app_event', { event: EVENT, data: { msg: 'hello from e2e' } });

    // Logs are indexed asynchronously; poll for the trigger's output message.
    let sawMessage = false;
    for (let i = 0; i < 15 && !sawMessage; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const logs = await call('get_flow_logs', { id: flowId });
        sawMessage = logs.includes('hello from e2e');
    }
    if (!sawMessage) throw new Error('Trigger output not found in flow logs.');

    console.log('E2E AUTHORING OK');
} finally {
    if (flowId) {
        await call('stop_flow', { id: flowId }, { allowError: true });
        await call('delete_flow', { id: flowId }, { allowError: true });
    }
    await client.close();
}
