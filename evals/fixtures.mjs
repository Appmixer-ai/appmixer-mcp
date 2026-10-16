// Flow fixtures for editing eval tasks: the runner creates one of these before
// the agent starts, so the task is "change this existing flow" rather than
// "build a new one". Each factory returns { flow, meta } where meta carries the
// component IDs the scorer needs.
import { randomUUID } from 'node:crypto';

const onAppEvent = (event, example) => ({
    type: 'appmixer.utils.appevents.OnAppEvent',
    label: 'Trigger',
    source: {},
    config: { properties: { event, eventDataExample: example } },
    x: 100, y: 200
});

const setVariable = (upstream, port, variablePath, name, position) => {
    const modifier = randomUUID();
    return {
        type: 'appmixer.utils.controls.SetVariable',
        label: `Set ${name}`,
        source: { in: { [upstream]: [port] } },
        config: {
            transform: {
                in: {
                    [upstream]: {
                        [port]: {
                            type: 'json2new',
                            modifiers: { variables: { [modifier]: { variable: variablePath, functions: [] } } },
                            lambda: { variables: { ADD: [{ name, type: 'text', text: `{{{${modifier}}}}` }] } }
                        }
                    }
                }
            }
        },
        ...position
    };
};

/** A valid two-step flow; the task asks for a third step to be appended. */
export function twoStepFlow() {
    const trigger = randomUUID(), first = randomUUID();
    return {
        flow: {
            [trigger]: onAppEvent('edit-append', '{"customer": "ACME", "amount": 120}'),
            [first]: setVariable(trigger, 'out', `$.${trigger}.out.data.customer`, 'customer',
                { x: 340, y: 200 })
        },
        meta: { trigger, first }
    };
}

/**
 * A flow whose variable path is wrong (missing the OnAppEvent `data` wrapper),
 * so it exists but does not validate; the task asks for a repair.
 */
export function brokenVariableFlow() {
    const trigger = randomUUID(), step = randomUUID();
    return {
        flow: {
            [trigger]: onAppEvent('edit-repair', '{"message": "hello"}'),
            // Wrong on purpose: the payload is nested under `data`.
            [step]: setVariable(trigger, 'out', `$.${trigger}.out.message`, 'copied',
                { x: 340, y: 200 })
        },
        meta: { trigger, step }
    };
}

export const FIXTURES = { twoStepFlow, brokenVariableFlow };
