// Live E2E: the MCP Gateway lifecycle. Builds a flow containing an
// "appmixer.ai.mcptools.MCPGateway" component with two action components wired
// to its 'tool' port, then verifies through the MCP server that starting the
// flow publishes those tools (with a tools/list_changed notification), that
// calling them runs the components, and that stopping the flow retracts them.
//
// Requires APPMIXER_* env vars AND a tenant with the appmixer.ai.mcptools
// module installed (connectors PR #1117). On a tenant without the module the
// suite skips instead of failing — see docs/status.md for which instance has it.
//
// Usage: node test/e2e-gateway.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.APPMIXER_BASE_URL;
if (!BASE) throw new Error('APPMIXER_BASE_URL is required.');

// The action component used as a gateway tool. MockValue is the smallest
// component that echoes an input field, which is all a tool call has to prove.
const TOOL_COMPONENT = 'appmixer.utils.controls.MockValue';
const ECHO_LABEL = 'EchoTool';
const GREET_LABEL = 'GreetTool';
const GREETING = 'Hello, Appmixer!';
const APPEARANCE_TIMEOUT_MS = 90_000;

/** A token the way an MCP client would hold one: given, or obtained by login. */
const token = process.env.APPMIXER_ACCESS_TOKEN || await (async () => {
    const auth = await fetch(`${BASE}/user/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: process.env.APPMIXER_USERNAME,
            password: process.env.APPMIXER_PASSWORD
        })
    });
    if (!auth.ok) throw new Error(`Tenant auth failed: ${auth.status}`);
    return (await auth.json()).token;
})();

// Preflight: without the mcptools plugin there is nothing to test. Its routes
// answer 404 when the module is absent and 401/200 when it is registered.
const probe = await fetch(`${BASE}/plugins/appmixer/ai/mcptools/gateways`, {
    headers: { Authorization: `Bearer ${token}` }
});
if (probe.status === 404) {
    console.log('SKIPPED: the appmixer.ai.mcptools module is not installed on this tenant.');
    process.exit(0);
}
if (!probe.ok) throw new Error(`Gateway registry unreachable: HTTP ${probe.status}`);

const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: { ...process.env, TOOLS: 'api,mcpgateway' },
    stderr: 'inherit'
});
const client = new Client({ name: 'e2e-gateway', version: '1.0.0' });

let listChanged = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });

await client.connect(transport);

const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError && !allowError) throw new Error(`${name} failed: ${text}`);
    console.log(`-- ${name}: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
    return text;
};

const toolNames = async () => (await client.listTools()).tools.map(tool => tool.name);
const endingWith = (names, suffix) => names.filter(name => name.endsWith(suffix));

/** Poll tools/list until the gateway tools are (or are no longer) published. */
const waitForTools = async (present) => {
    const deadline = Date.now() + APPEARANCE_TIMEOUT_MS;
    for (;;) {
        const names = await toolNames();
        const found = endingWith(names, `_${ECHO_LABEL}`).length
            + endingWith(names, `_${GREET_LABEL}`).length;
        if (present ? found === 2 : found === 0) return names;
        if (Date.now() > deadline) {
            throw new Error(`Gateway tools ${present ? 'did not appear' : 'were not retracted'} ` +
                `within ${APPEARANCE_TIMEOUT_MS / 1000}s. tools/list: ${names.join(', ')}`);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
};

/**
 * What the tenant itself thinks it published. On a failure this is the only way
 * to tell the three causes apart: no gateway entry at all (the component never
 * started), an entry whose `tools` is empty (the tool port was not understood,
 * or a manifest could not be fetched), or an entry we fail to reconcile.
 * The component logs its own view under the steps `component-tools`,
 * `component-tool-manifest-inspect` and `component-tool-manifest-error`.
 */
const dumpDiagnostics = async (id) => {
    try {
        const res = await fetch(`${BASE}/plugins/appmixer/ai/mcptools/gateways`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`!! gateway registry (HTTP ${res.status}): ${await res.text()}`);
    } catch (err) {
        console.log(`!! gateway registry unreadable: ${err.message}`);
    }
    if (!id) return;
    try {
        const logs = await client.callTool({ name: 'get_flow_logs', arguments: { id, size: 100 } });
        console.log(`!! flow logs: ${logs.content?.[0]?.text ?? '(none)'}`);
    } catch (err) {
        console.log(`!! flow logs unreadable: ${err.message}`);
    }
};

// A tool component is configured through the transform of the port it is wired
// to: a modifier reading `modelDefinedParameter` makes the field a tool
// parameter, a literal lambda value makes it a static value the caller cannot
// set. Mirrors the module's own E2E flow.
const toolTransform = (field, modelDefined, staticValue) => ({
    in: {
        gateway: {
            tool: {
                type: 'json2new',
                modifiers: modelDefined
                    ? { [field]: { param: { variable: '$.gateway.tool.modelDefinedParameter', functions: [] } } }
                    : {},
                lambda: { [field]: modelDefined ? '{{{param}}}' : staticValue }
            }
        }
    }
});

const flow = {
    gateway: {
        type: 'appmixer.ai.mcptools.MCPGateway',
        label: 'Gateway',
        source: {},
        config: {},
        x: 300, y: 200
    },
    echo: {
        type: TOOL_COMPONENT,
        label: ECHO_LABEL,
        source: { in: { gateway: ['tool'] } },
        config: { transform: toolTransform('value', true) },
        x: 200, y: 400
    },
    greet: {
        type: TOOL_COMPONENT,
        label: GREET_LABEL,
        source: { in: { gateway: ['tool'] } },
        config: { transform: toolTransform('value', false, GREETING) },
        x: 500, y: 400
    }
};

const baseline = await toolNames();
if (endingWith(baseline, `_${ECHO_LABEL}`).length) {
    throw new Error('A gateway tool of a previous run is still published; clean up its flow first.');
}

let flowId;
try {
    const created = JSON.parse(await call('create_flow', {
        name: `mcp-e2e-gateway-${Date.now()}`,
        flow
    }));
    // create_flow reports an unknown component type as a plain error result.
    if (created.error) throw new Error(`create_flow rejected the descriptor: ${created.error}`);
    flowId = created.flowId;
    // Validation is covered by e2e-authoring and golden-flows; here it is only
    // a diagnostic, so a validator that does not model the 'tool' port cannot
    // fail the lifecycle test. A descriptor broken for real fails below anyway.
    if (created.validation?.valid !== true) {
        console.warn(`!! flow did not validate: ${JSON.stringify(created.validation)}`);
    }

    const changesBeforeStart = listChanged;
    await call('start_flow', { id: flowId });

    let published;
    try {
        published = await waitForTools(true);
    } catch (err) {
        await dumpDiagnostics(flowId);
        throw err;
    }
    const echoName = endingWith(published, `_${ECHO_LABEL}`)[0];
    const greetName = endingWith(published, `_${GREET_LABEL}`)[0];
    console.log(`-- published: ${echoName}, ${greetName}`);

    // The server must have told the client the list changed, not just answered
    // a later tools/list correctly — that notification is the whole point of
    // the dynamic registration.
    if (listChanged <= changesBeforeStart) {
        throw new Error('No tools/list_changed notification after the flow started.');
    }

    const { tools } = await client.listTools();
    const echo = tools.find(tool => tool.name === echoName);
    const greet = tools.find(tool => tool.name === greetName);

    if (echo.title !== ECHO_LABEL) throw new Error(`Expected title ${ECHO_LABEL}, got ${echo.title}`);
    if (!echo.inputSchema?.properties?.value) {
        throw new Error(`Model-defined parameter missing from the echo tool schema: ` +
            JSON.stringify(echo.inputSchema));
    }
    // The static field must not be offered to the model.
    if (greet.inputSchema?.properties?.value) {
        throw new Error('The static field is exposed as a tool parameter.');
    }

    const echoed = await call(echoName, { value: 'hello from e2e' });
    if (!echoed.includes('hello from e2e')) {
        throw new Error(`Echo tool did not return its input: ${echoed}`);
    }
    const greeted = await call(greetName, {});
    if (!greeted.includes(GREETING)) {
        throw new Error(`Static tool did not return ${GREETING}: ${greeted}`);
    }

    const changesBeforeStop = listChanged;
    await call('stop_flow', { id: flowId });
    await waitForTools(false);
    if (listChanged <= changesBeforeStop) {
        throw new Error('No tools/list_changed notification after the flow stopped.');
    }

    console.log('E2E GATEWAY OK');
} finally {
    if (flowId) {
        await call('stop_flow', { id: flowId }, { allowError: true });
        await call('delete_flow', { id: flowId }, { allowError: true });
    }
    await client.close();
}
