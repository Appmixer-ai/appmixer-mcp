// Live smoke test: spawns the built server over stdio and exercises tools/list
// + a read-only tool call against a real tenant. Requires APPMIXER_* env vars.
// Usage: node test/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP_SERVER_ENTRY lets the same smoke test exercise the MCPB bundle, which
// must run standalone (no node_modules next to it).
const entry = process.env.MCP_SERVER_ENTRY || 'dist/index.js';
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env },
    stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools/list: ${tools.length} tools -> ${tools.map(t => t.name).join(', ')}`);

for (const tool of tools) {
    if (tool.name.length > 64) throw new Error(`Tool name too long: ${tool.name}`);
    if (!tool.description) throw new Error(`Tool missing description: ${tool.name}`);
}

const result = await client.callTool({ name: 'list_flows', arguments: { limit: 5 } });
if (result.isError) throw new Error(`list_flows failed: ${result.content[0].text}`);
console.log('list_flows:', result.content[0].text.slice(0, 400));

await client.close();
console.log('SMOKE OK');
