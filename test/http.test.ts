import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http.js';
import { loadHttpConfig } from '../src/config.js';
import { futureJwt, jsonResponse } from './helpers.js';

const APPMIXER_URL = 'https://api.tenant.appmixer.cloud';
const realFetch = globalThis.fetch;

// Upstream (Appmixer API) mock; requests to our own express server pass through.
const upstreamMock = vi.fn();

async function startServer(env: Record<string, string>) {
    const config = loadHttpConfig({
        APPMIXER_BASE_URL: APPMIXER_URL,
        MCP_ALLOWED_ORIGINS: 'https://allowed.example.com',
        TOOLS: 'api',
        ...env
    });
    const httpApp = createHttpApp(config, () => {});
    const server = httpApp.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/mcp`, server, httpApp };
}

async function connect(url: string, token?: string) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    return { client, transport };
}

describe('streamable HTTP transport', () => {

    beforeAll(() => {
        vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
            return upstreamMock(url, init);
        }) as typeof fetch);
    });
    afterAll(() => {
        vi.unstubAllGlobals();
    });
    beforeEach(() => {
        upstreamMock.mockReset();
        upstreamMock.mockImplementation(() => Promise.resolve(jsonResponse([])));
    });

    it('serves tools over HTTP in bearer mode and scopes the session to the token', async () => {
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            const { client } = await connect(url, futureJwt());
            const { tools } = await client.listTools();
            expect(tools.length).toBe(37);

            const result = await client.callTool({ name: 'list_flows', arguments: {} });
            expect(result.isError).toBeFalsy();
            // The upstream call used the caller's bearer token.
            const flowsCall = upstreamMock.mock.calls.find(([u]) => String(u).includes('/flows'));
            expect(flowsCall).toBeDefined();
            await client.close();
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('rejects unauthenticated requests in bearer mode with 401', async () => {
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            await expect(connect(url)).rejects.toThrow(/Missing Authorization header/);
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('refuses to create a session for a token the tenant rejects', async () => {
        upstreamMock.mockImplementation((url: string) => Promise.resolve(
            String(url).endsWith('/user')
                ? jsonResponse({ message: 'unauthorized' }, 401)
                : jsonResponse([])));
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            await expect(connect(url, futureJwt())).rejects.toThrow(/rejected this access token/);
            // The credential never bought any session state.
            const health = await realFetch(url.replace('/mcp', '/healthz')).then(r => r.json()) as { sessions: number };
            expect(health.sessions).toBe(0);
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('rejects a session reused with a different token', async () => {
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            const first = await connect(url, futureJwt(7200));
            const sessionId = first.transport.sessionId!;
            expect(sessionId).toBeTruthy();

            const response = await realFetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'Authorization': `Bearer ${futureJwt(9999)}`,
                    'Mcp-Session-Id': sessionId
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
            });
            expect(response.status).toBe(401);
            await first.client.close();
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('works in env mode without Authorization', async () => {
        const { url, server, httpApp } = await startServer({ APPMIXER_ACCESS_TOKEN: futureJwt() });
        try {
            const { client } = await connect(url);
            const { tools } = await client.listTools();
            expect(tools.length).toBe(37);
            await client.close();
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('rejects disallowed browser origins', async () => {
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            const response = await realFetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'Origin': 'https://evil.example.com',
                    'Authorization': `Bearer ${futureJwt()}`
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
            });
            expect(response.status).toBe(403);
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('refuses new sessions above the configured capacity', async () => {
        const { url, server, httpApp } = await startServer({
            MCP_AUTH_MODE: 'bearer', MCP_MAX_SESSIONS: '1'
        });
        try {
            const first = await connect(url, futureJwt());
            await expect(connect(url, futureJwt(7200))).rejects.toThrow(/at capacity/);
            await first.client.close();
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('rate limits session creation per client', async () => {
        const { url, server, httpApp } = await startServer({
            MCP_AUTH_MODE: 'bearer', MCP_RATE_LIMIT_PER_MINUTE: '1'
        });
        try {
            const first = await connect(url, futureJwt());
            await expect(connect(url, futureJwt(7200))).rejects.toThrow(/Too many session attempts/);
            await first.client.close();
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('remembers a rejected token instead of asking the tenant again', async () => {
        let userCalls = 0;
        upstreamMock.mockImplementation((url: string) => {
            if (String(url).endsWith('/user')) {
                userCalls++;
                return Promise.resolve(jsonResponse({ message: 'unauthorized' }, 401));
            }
            return Promise.resolve(jsonResponse([]));
        });
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            const token = futureJwt();
            await expect(connect(url, token)).rejects.toThrow(/rejected this access token/);
            await expect(connect(url, token)).rejects.toThrow(/rejected this access token/);
            // The second attempt was answered from the local cache.
            expect(userCalls).toBe(1);
        } finally {
            httpApp.close(); server.close();
        }
    });

    it('exposes a health endpoint outside /mcp', async () => {
        const { url, server, httpApp } = await startServer({ MCP_AUTH_MODE: 'bearer' });
        try {
            const response = await realFetch(url.replace('/mcp', '/healthz'));
            expect(response.status).toBe(200);
            const body = await response.json() as { status: string };
            expect(body.status).toBe('ok');
        } finally {
            httpApp.close(); server.close();
        }
    });
});
