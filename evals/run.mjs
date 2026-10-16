// LLM eval runner: measures how well an LLM agent builds Appmixer flows
// through this MCP server, task by task. For each task it spawns
// `claude -p` with the server mounted via --mcp-config, then scores the
// created flow objectively via the Appmixer API (existence, validity,
// expected components, first-try validity, tool-call efficiency).
//
// Requires: APPMIXER_* env vars, the `claude` CLI on PATH, `npm run build`.
// Usage:    node evals/run.mjs [--model sonnet] [--only task-id] [--keep]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FIXTURES } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
};
const MODEL = flag('--model') || 'sonnet';
const ONLY = flag('--only'); // Single id or comma-separated list.
const KEEP = args.includes('--keep');
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

const BASE = process.env.APPMIXER_BASE_URL;
if (!BASE) { console.error('APPMIXER_BASE_URL not set.'); process.exit(1); }

// ---- Appmixer API helpers (scoring side) -----------------------------------

let token;
async function api(path, method = 'GET', body) {
    if (!token) {
        const auth = await fetch(`${BASE}/user/auth`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: process.env.APPMIXER_USERNAME,
                password: process.env.APPMIXER_PASSWORD
            })
        });
        if (!auth.ok) throw new Error(`Tenant auth failed: ${auth.status}`);
        token = (await auth.json()).token;
    }
    const response = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

// ---- Agent invocation -------------------------------------------------------

const mcpConfigPath = join(tmpdir(), `appmixer-mcp-eval-${Date.now()}.json`);
writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
        appmixer: {
            command: process.execPath,
            args: [join(root, 'dist', 'index.js')],
            env: {
                APPMIXER_BASE_URL: BASE,
                APPMIXER_USERNAME: process.env.APPMIXER_USERNAME || '',
                APPMIXER_PASSWORD: process.env.APPMIXER_PASSWORD || '',
                APPMIXER_ACCESS_TOKEN: process.env.APPMIXER_ACCESS_TOKEN || '',
                TOOLS: 'api'
            }
        }
    }
}));

function runAgent(prompt) {
    return new Promise((resolvePromise) => {
        // The prompt goes through stdin: with shell:true (needed for claude.cmd
        // on Windows), prompt text in argv would be mangled by shell quoting.
        const child = spawn('claude', [
            '-p',
            '--model', MODEL,
            '--mcp-config', mcpConfigPath,
            '--strict-mcp-config',
            '--allowedTools', 'mcp__appmixer', 'mcp__appmixer__*',
            '--max-turns', '40',
            '--output-format', 'stream-json',
            '--verbose'
        ], { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.write(prompt);
        child.stdin.end();

        const toolCalls = {};
        const trace = [];               // Ordered tool calls with inputs + result excerpts.
        const pendingById = new Map();  // tool_use_id -> trace entry.
        let resultEvent = null;
        let stderr = '';
        let buffer = '';
        const timer = setTimeout(() => child.kill(), TASK_TIMEOUT_MS);

        child.stdout.on('data', chunk => {
            buffer += chunk.toString();
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.type === 'assistant') {
                    for (const block of event.message?.content || []) {
                        if (block.type === 'tool_use') {
                            const isMcp = block.name.startsWith('mcp__appmixer__');
                            const name = block.name.replace(/^mcp__appmixer__/, '');
                            toolCalls[name] = (toolCalls[name] || 0) + 1;
                            const entry = {
                                tool: name,
                                isMcp,
                                input: JSON.stringify(block.input).slice(0, 2000)
                            };
                            trace.push(entry);
                            pendingById.set(block.id, entry);
                        }
                    }
                } else if (event.type === 'user') {
                    for (const block of event.message?.content || []) {
                        if (block.type === 'tool_result' && pendingById.has(block.tool_use_id)) {
                            const text = (Array.isArray(block.content)
                                ? block.content.map(c => c.text || '').join('')
                                : String(block.content ?? ''));
                            pendingById.get(block.tool_use_id).result = text.slice(0, 2000);
                        }
                    }
                } else if (event.type === 'result') {
                    resultEvent = event;
                }
            }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('close', () => {
            clearTimeout(timer);
            resolvePromise({ toolCalls, trace, resultEvent, stderr });
        });
    });
}

// ---- Scoring ----------------------------------------------------------------

async function scoreTask(task, marker, agent, fixture) {
    const score = {
        id: task.id, created: false, valid: false, validFirstTry: false,
        componentsOk: false, extraChecksOk: true, toolCalls: agent.toolCalls,
        totalToolCalls: Object.values(agent.toolCalls).reduce((a, b) => a + b, 0),
        // Calls into this server, as opposed to the host's own tools (file
        // search, sub-agents, shell). Only the former measures our tool surface.
        mcpToolCalls: agent.trace.filter(entry => entry.isMcp).length,
        turns: agent.resultEvent?.num_turns,
        costUsd: agent.resultEvent?.total_cost_usd,
        flowId: null, notes: []
    };

    // Editing tasks score the fixture flow itself; authoring tasks look up the
    // flow the agent was told to name with a unique marker.
    let flow;
    if (fixture) {
        const { body: existing } = await api(`/flows/${fixture.flowId}`);
        flow = existing ? { flowId: fixture.flowId, name: existing.name } : undefined;
    } else {
        const { body: flows } = await api(`/flows?pattern=${encodeURIComponent(marker)}&projection=-thumbnail`);
        flow = Array.isArray(flows) ? flows.find(f => f.name?.includes(marker)) : undefined;
    }
    if (!flow) { score.notes.push('Flow not found.'); return score; }
    score.created = true;
    score.flowId = flow.flowId;

    const { body: full } = await api(`/flows/${flow.flowId}`);
    const descriptor = full?.flow || {};
    const descriptorJson = JSON.stringify(descriptor);
    const types = Object.values(descriptor).map(c => c.type || '');

    const { body: validation } = await api(`/flows/${flow.flowId}/validate`);
    score.valid = (validation?.errors || []).length === 0;
    if (!score.valid) score.notes.push(`Validation errors: ${JSON.stringify(validation.errors).slice(0, 300)}`);
    // Connected-service components cannot validate before their account is bound,
    // and binding needs the flow to exist — so one corrective round is structural
    // rather than a modelling mistake (see the guide's account section).
    score.bindingRoundExpected = Boolean(task.accountBindingRequired);
    // "First try" = no corrective round. Editing a flow spends one update_flow on
    // the change itself, so only a second one counts as a correction.
    const updates = agent.toolCalls.update_flow || 0;
    score.validFirstTry = score.valid && updates <= (fixture ? 1 : 0);

    const missing = (task.expectComponents || []).filter(want => !types.some(t => t.includes(want)));
    const anyOk = !task.expectAnyComponent
        || task.expectAnyComponent.some(want => types.some(t => t.includes(want)));
    score.componentsOk = missing.length === 0 && anyOk
        && (!task.minComponents || types.length >= task.minComponents);
    if (missing.length) score.notes.push(`Missing components: ${missing.join(', ')}`);
    if (!anyOk) score.notes.push(`None of ${task.expectAnyComponent.join('/')} present.`);

    for (const needle of task.expectDescriptorIncludes || []) {
        if (!descriptorJson.includes(needle)) {
            score.extraChecksOk = false;
            score.notes.push(`Descriptor missing "${needle}".`);
        }
    }
    if (task.expectAccountAssigned) {
        const { body: bindings } = await api(`/accounts/flow/${flow.flowId}`);
        const assigned = Object.values(bindings || {}).filter(Boolean);
        if (!assigned.length) {
            score.extraChecksOk = false;
            score.notes.push('No component of the flow has an account assigned.');
        }
    }
    if (fixture && task.expectPreservedComponentIds) {
        const dropped = Object.keys(fixture.flow).filter(id => !descriptor[id]);
        if (dropped.length) {
            score.extraChecksOk = false;
            score.notes.push(`Existing component IDs were not preserved: ${dropped.join(', ')}.`);
        }
    }
    if (fixture && task.expectPreservedLayout) {
        const moved = Object.entries(fixture.flow)
            .filter(([id, original]) => descriptor[id]
                && (descriptor[id].x !== original.x || descriptor[id].y !== original.y))
            .map(([id]) => id);
        if (moved.length) {
            score.extraChecksOk = false;
            score.notes.push(`Existing components were moved: ${moved.join(', ')}.`);
        }
    }
    if (task.minPlaceholders) {
        const count = (descriptorJson.match(/\{\{\{[0-9a-f-]{36}\}\}\}/g) || []).length;
        if (count < task.minPlaceholders) {
            score.extraChecksOk = false;
            score.notes.push(`Only ${count} placeholders, expected >= ${task.minPlaceholders}.`);
        }
    }

    if (!KEEP) {
        // An agent that retried may have left several flows behind under the
        // same name; clean up all of them, not just the scored one.
        const { body: leftovers } = await api(`/flows?pattern=${encodeURIComponent(marker)}&projection=-thumbnail`);
        const ids = new Set([flow.flowId, ...(Array.isArray(leftovers) ? leftovers : [])
            .filter(f => f.name?.includes(marker)).map(f => f.flowId)]);
        for (const id of ids) await api(`/flows/${id}`, 'DELETE');
    }
    return score;
}

// ---- Main -------------------------------------------------------------------

const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))
    .filter(task => !ONLY || ONLY.split(',').includes(task.id));

console.log(`Running ${tasks.length} eval task(s) with model "${MODEL}"...\n`);
const results = [];

for (const task of tasks) {
    const marker = `eval-${task.id}-${Date.now()}`;

    // Editing tasks start from a flow the runner creates; the agent is pointed
    // at it by name and must change it in place.
    let fixture;
    if (task.fixture) {
        const factory = FIXTURES[task.fixture];
        if (!factory) throw new Error(`Unknown fixture "${task.fixture}" on task ${task.id}.`);
        const built = factory();
        const { body: created } = await api('/flows', 'POST', { name: marker, flow: built.flow });
        fixture = { flowId: created.flowId, flow: built.flow, meta: built.meta };
    }

    const prompt = fixture
        ? `${task.prompt}\n\nUse the Appmixer MCP tools. The flow is named exactly "${marker}" ` +
          '— change that existing flow, do not create a new one. Make sure it passes validation ' +
          'and do NOT start it. When finished, reply with only the flow ID.'
        : `${task.prompt}\n\nUse the Appmixer MCP tools. Name the flow exactly "${marker}". ` +
          'Create the flow and make sure it passes validation. Do NOT start the flow. ' +
          'When finished, reply with only the flow ID.';
    process.stdout.write(`- ${task.id} ... `);
    const started = Date.now();
    const agent = await runAgent(prompt);
    const score = await scoreTask(task, marker, agent, fixture);
    score.trace = agent.trace;
    score.durationS = Math.round((Date.now() - started) / 1000);
    const pass = score.created && score.valid && score.componentsOk && score.extraChecksOk;
    score.pass = pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} (valid=${score.valid}, firstTry=${score.validFirstTry}, ` +
        `mcpCalls=${score.mcpToolCalls}/${score.totalToolCalls}, ${score.durationS}s${score.costUsd ? `, $${score.costUsd.toFixed(2)}` : ''})`);
    for (const note of score.notes) console.log(`    ! ${note}`);
    results.push(score);
}

// First-try validity is only meaningful where a single pass can succeed.
const firstTryScope = results.filter(r => !r.bindingRoundExpected);

const summary = {
    model: MODEL,
    date: new Date().toISOString(),
    tasks: results.length,
    passed: results.filter(r => r.pass).length,
    valid: results.filter(r => r.valid).length,
    validFirstTry: firstTryScope.filter(r => r.validFirstTry).length,
    firstTryScope: firstTryScope.length,
    bindingRoundExpected: results.length - firstTryScope.length,
    avgToolCalls: Math.round(results.reduce((a, r) => a + r.totalToolCalls, 0) / results.length * 10) / 10,
    avgMcpToolCalls: Math.round(results.reduce((a, r) => a + r.mcpToolCalls, 0) / results.length * 10) / 10,
    totalCostUsd: Math.round(results.reduce((a, r) => a + (r.costUsd || 0), 0) * 100) / 100,
    results
};

mkdirSync(join(here, 'results'), { recursive: true });
const outPath = join(here, 'results', `${summary.date.replace(/[:.]/g, '-')}-${MODEL}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.log(`\n=== EVAL SUMMARY (${MODEL}) ===`);
console.log(`pass:          ${summary.passed}/${summary.tasks}`);
console.log(`valid:         ${summary.valid}/${summary.tasks}`);
console.log(`valid 1st try: ${summary.validFirstTry}/${summary.firstTryScope}` +
    (summary.bindingRoundExpected
        ? ` (${summary.bindingRoundExpected} excluded: account binding needs a second pass)`
        : ''));
console.log(`avg mcp calls: ${summary.avgMcpToolCalls} (of ${summary.avgToolCalls} total incl. host tools)`);
console.log(`total cost:    $${summary.totalCostUsd}`);
console.log(`saved:         ${outPath}`);
