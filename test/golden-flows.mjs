// Live golden-flow suite: canonical descriptors exercising the patterns from
// the flow authoring guide (branching, modifier functions, error port). Each
// golden must pass server-side validation; one is also dry-run via test_flow
// and inspected via get_flow_variables. Requires APPMIXER_* env vars.
// Usage: node test/golden-flows.mjs
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: { ...process.env, TOOLS: 'api' },
    stderr: 'inherit'
});
const client = new Client({ name: 'golden-flows', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    return text;
};

const onAppEvent = (id, event) => ({
    type: 'appmixer.utils.appevents.OnAppEvent',
    label: 'Trigger',
    source: {},
    config: { properties: { event, eventDataExample: '{"msg": "hello", "n": 5}' } },
    x: 100, y: 200
});

const setVariable = (upstream, port, modifiers, addItems, position) => ({
    type: 'appmixer.utils.controls.SetVariable',
    label: 'Set variables',
    source: { in: { [upstream]: [port] } },
    config: {
        transform: {
            in: {
                [upstream]: {
                    [port]: {
                        type: 'json2new',
                        modifiers: { variables: modifiers },
                        lambda: { variables: { ADD: addItems } }
                    }
                }
            }
        }
    },
    ...position
});

function goldenConditionBranching() {
    const t = randomUUID(), cond = randomUUID(), yes = randomUUID(), no = randomUUID();
    const m = randomUUID(), mYes = randomUUID(), mNo = randomUUID();
    return {
        name: 'golden-condition-branching',
        flow: {
            [t]: onAppEvent(t, 'golden-cond'),
            [cond]: {
                type: 'appmixer.utils.controls.Condition',
                label: 'Contains urgent?',
                source: { in: { [t]: ['out'] } },
                config: {
                    transform: {
                        in: {
                            [t]: {
                                out: {
                                    type: 'json2new',
                                    modifiers: {
                                        expression: { [m]: { variable: `$.${t}.out.data.msg`, functions: [] } }
                                    },
                                    lambda: {
                                        expression: {
                                            AND: [{ OR: [{ input: `{{{${m}}}}`, operator: 'contains', value: 'urgent' }] }]
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                x: 300, y: 200
            },
            [yes]: setVariable(cond, 'true',
                { [mYes]: { variable: `$.${t}.out.data.msg`, functions: [] } },
                [{ name: 'urgentMsg', type: 'text', text: `{{{${mYes}}}}` }],
                { x: 500, y: 100 }),
            [no]: setVariable(cond, 'false',
                { [mNo]: { variable: `$.${t}.out.data.msg`, functions: [] } },
                [{ name: 'normalMsg', type: 'text', text: `{{{${mNo}}}}` }],
                { x: 500, y: 300 })
        }
    };
}

function goldenModifierFunctions() {
    const t = randomUUID(), set = randomUUID();
    const mLength = randomUUID(), mMsg = randomUUID();
    return {
        name: 'golden-modifier-functions',
        testComponent: set,
        flow: {
            [t]: onAppEvent(t, 'golden-mods'),
            [set]: setVariable(t, 'out',
                {
                    [mLength]: { variable: `$.${t}.out.data.msg`, functions: [{ name: 'g_length' }] },
                    [mMsg]: { variable: `$.${t}.out.data.msg`, functions: [] }
                },
                [{ name: 'summary', type: 'text', text: `Message "{{{${mMsg}}}}" has {{{${mLength}}}} chars` }],
                { x: 300, y: 200 })
        }
    };
}

function goldenErrorPort() {
    const t = randomUUID(), gt = randomUUID(), ok = randomUUID(), onError = randomUUID();
    const mN = randomUUID(), mOk = randomUUID(), mErr = randomUUID();
    return {
        name: 'golden-error-port',
        flow: {
            [t]: onAppEvent(t, 'golden-err'),
            [gt]: {
                type: 'appmixer.utils.filters.GreaterThan',
                label: 'n > 10?',
                source: { in: { [t]: ['out'] } },
                errorHandling: { autoRetry: false, onError: 'errorPort' },
                config: {
                    transform: {
                        in: {
                            [t]: {
                                out: {
                                    type: 'json2new',
                                    modifiers: {
                                        sourceData: { [mN]: { variable: `$.${t}.out.data.n`, functions: [] } }
                                    },
                                    lambda: { sourceData: `{{{${mN}}}}`, greaterThan: '10' }
                                }
                            }
                        }
                    }
                },
                x: 300, y: 200
            },
            [ok]: setVariable(gt, 'greater',
                { [mOk]: { variable: `$.${t}.out.data.n`, functions: [] } },
                [{ name: 'big', type: 'text', text: `{{{${mOk}}}}` }],
                { x: 500, y: 100 }),
            [onError]: setVariable(gt, 'error',
                { [mErr]: { variable: `$.${gt}.error.error.message`, functions: [] } },
                [{ name: 'failure', type: 'text', text: `{{{${mErr}}}}` }],
                { x: 500, y: 300 })
        }
    };
}

function goldenWebhookTrigger() {
    const t = randomUUID(), set = randomUUID(), m = randomUUID();
    return {
        name: 'golden-webhook-trigger',
        triggerUrlComponent: t,
        flow: {
            [t]: {
                type: 'appmixer.utils.http.WebhookTrigger',
                label: 'Incoming webhook',
                source: {},
                config: {},
                x: 100, y: 200
            },
            [set]: setVariable(t, 'request',
                { [m]: { variable: `$.${t}.request.method`, functions: [] } },
                [{ name: 'method', type: 'text', text: `{{{${m}}}}` }],
                { x: 300, y: 200 })
        }
    };
}

const goldens = [goldenConditionBranching(), goldenModifierFunctions(), goldenErrorPort(), goldenWebhookTrigger()];
let failures = 0;

for (const golden of goldens) {
    let flowId;
    try {
        const created = JSON.parse(await call('create_flow', { name: golden.name, flow: golden.flow }));
        flowId = created.flowId;
        if (created.validation?.valid !== true) {
            failures++;
            console.error(`GOLDEN FAIL ${golden.name}: ${JSON.stringify(created.validation)}`);
            continue;
        }
        console.log(`golden ok: ${golden.name}`);

        if (golden.testComponent) {
            // Exercise get_flow_variables: the exact path must be discoverable.
            const variables = await call('get_flow_variables', { id: flowId });
            if (!variables.includes('.out.data.msg')) {
                throw new Error('get_flow_variables did not report the expected path.');
            }
            // Exercise get_component_options on the trigger (dynamic output-port
            // options resolved at runtime from eventDataExample).
            const trigger = Object.entries(golden.flow)
                .find(([, c]) => c.type === 'appmixer.utils.appevents.OnAppEvent');
            const options = await call('get_component_options', {
                component_type: 'appmixer.utils.appevents.OnAppEvent',
                component_id: trigger[0],
                out_port: 'out',
                properties: {
                    generateOutputPortOptions: true,
                    event: trigger[1].config.properties.event,
                    eventDataExample: trigger[1].config.properties.eventDataExample
                }
            });
            if (!options.includes('"value": "data"')) {
                throw new Error(`get_component_options did not resolve trigger options: ${options.slice(0, 200)}`);
            }
            // Dry-run the component via test_flow.
            const test = JSON.parse(await call('test_flow', {
                id: flowId,
                component_id: golden.testComponent,
                input_data: { in: { variables: { ADD: [{ name: 'summary', type: 'text', text: 'direct' }] } } },
                timeout_seconds: 30
            }));
            if (test.status !== 'completed') throw new Error(`test_flow status: ${test.status}`);
            console.log(`golden ok: ${golden.name} (test_flow completed, ${test.outputs.length} outputs)`);
        }
        if (golden.triggerUrlComponent) {
            const url = await call('get_trigger_url', { flow_id: flowId, component_id: golden.triggerUrlComponent });
            if (!url.includes(`/flows/${flowId}/components/${golden.triggerUrlComponent}`)) {
                throw new Error(`get_trigger_url returned unexpected value: ${url.slice(0, 200)}`);
            }
            console.log(`golden ok: ${golden.name} (trigger URL resolved)`);
        }
    } catch (err) {
        failures++;
        console.error(`GOLDEN FAIL ${golden.name}:`, err.message);
    } finally {
        if (flowId) await call('delete_flow', { id: flowId }).catch(() => {});
    }
}

await client.close();
if (failures) {
    console.error(`GOLDEN FLOWS FAILED: ${failures}`);
    process.exit(1);
}
console.log('GOLDEN FLOWS OK');
