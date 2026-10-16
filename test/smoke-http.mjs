// Live HTTP smoke test: starts the HTTP server in bearer mode, authenticates
// against the real tenant, connects an MCP client with the bearer token and
// calls a read-only tool. Requires APPMIXER_* env vars.
// Usage: node test/smoke-http.mjs
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3941;
const BASE = process.env.APPMIXER_BASE_URL;

// 1. Get a real Appmixer token (as an MCP client user would).
const auth = await fetch(`${BASE}/user/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        username: process.env.APPMIXER_USERNAME,
        password: process.env.APPMIXER_PASSWORD
    })
});
if (!auth.ok) throw new Error(`Tenant auth failed: ${auth.status}`);
const { token } = await auth.json();

// 2. Start the HTTP server in bearer mode (no credentials in its env).
const server = spawn(process.execPath, ['dist/http-main.js'], {
    env: {
        ...process.env,
        APPMIXER_USERNAME: '', APPMIXER_PASSWORD: '', APPMIXER_ACCESS_TOKEN: '',
        MCP_AUTH_MODE: 'bearer', MCP_HTTP_PORT: String(PORT), TOOLS: 'api'
    },
    stdio: ['ignore', 'inherit', 'inherit']
});

try {
    // Wait for /healthz.
    let healthy = false;
    for (let i = 0; i < 30 && !healthy; i++) {
        await new Promise(resolve => setTimeout(resolve, 300));
        healthy = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(r => r.ok, () => false);
    }
    if (!healthy) throw new Error('HTTP server did not become healthy.');

    // 3. Unauthenticated must fail.
    const unauthenticated = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    if (unauthenticated.status !== 401) throw new Error(`Expected 401, got ${unauthenticated.status}`);

    // 4. Authenticated MCP session works end to end.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: 'smoke-http', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`tools/list over HTTP: ${tools.length} tools`);
    const result = await client.callTool({ name: 'list_flows', arguments: { limit: 3 } });
    if (result.isError) throw new Error(`list_flows failed: ${result.content[0].text}`);
    console.log('list_flows over HTTP:', result.content[0].text.slice(0, 200).replace(/\n/g, ' '));
    await client.close();
    console.log('SMOKE HTTP OK');
} finally {
    server.kill();
}
