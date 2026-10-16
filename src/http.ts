import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { HttpConfig } from './config.js';
import { ApiError, describeError } from './errors.js';
import { createAppmixerServer, type AppmixerMcpServer, VERSION } from './server.js';
import type { Logger } from './tools/gateway.js';

interface Session {
    transport: StreamableHTTPServerTransport;
    app: AppmixerMcpServer;
    /** sha256 of the bearer token the session was created with ('' in env mode). */
    tokenHash: string;
    lastSeen: number;
}

const SESSION_SWEEP_INTERVAL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
/** How long a credential the tenant rejected stays rejected without asking again. */
const REJECTED_TOKEN_TTL_MS = 60_000;

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function rpcError(res: Response, httpStatus: number, message: string): void {
    res.status(httpStatus).json({
        jsonrpc: '2.0',
        error: { code: -32000, message },
        id: null
    });
}

export interface HttpApp {
    app: express.Express;
    /** Closes all sessions and stops the sweep timer. */
    close(): void;
}

export function createHttpApp(config: HttpConfig, log: Logger): HttpApp {

    const sessions = new Map<string, Session>();
    // Session-creation attempts per client address, and tokens the tenant has
    // just rejected: both keep an unauthenticated caller from making this
    // server relay traffic to the Appmixer API on their behalf.
    const attempts = new Map<string, number[]>();
    const rejectedTokens = new Map<string, number>();
    const app = express();
    app.use(express.json({ limit: '4mb' }));

    /** True when this address is over its session-creation budget. */
    const rateLimited = (address: string): boolean => {
        if (!config.rateLimitPerMinute) return false;
        const now = Date.now();
        const recent = (attempts.get(address) || []).filter(at => at > now - RATE_WINDOW_MS);
        recent.push(now);
        attempts.set(address, recent);
        return recent.length > config.rateLimitPerMinute;
    };

    const sweepTimer = setInterval(() => {
        const now = Date.now();
        const cutoff = now - config.sessionIdleMs;
        for (const [id, session] of sessions) {
            if (session.lastSeen < cutoff) {
                log(`Closing idle MCP session ${id}.`);
                void session.transport.close();
                sessions.delete(id);
            }
        }
        // Keep the anti-abuse bookkeeping from growing without bound.
        for (const [address, times] of attempts) {
            const recent = times.filter(at => at > now - RATE_WINDOW_MS);
            if (recent.length) attempts.set(address, recent);
            else attempts.delete(address);
        }
        for (const [hash, at] of rejectedTokens) {
            if (at <= now - REJECTED_TOKEN_TTL_MS) rejectedTokens.delete(hash);
        }
    }, SESSION_SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    app.get('/healthz', (_req, res) => {
        res.json({
            status: 'ok', name: 'appmixer-mcp', version: VERSION,
            sessions: sessions.size, maxSessions: config.maxSessions
        });
    });

    // DNS-rebinding protection (spec MUST): browser requests carry an Origin
    // header; reject any Origin that is not explicitly allowed. Requests
    // without an Origin (CLI/server MCP clients) pass.
    app.use('/mcp', (req, res, next) => {
        const origin = (req.headers.origin || '').replace(/\/+$/, '');
        if (origin && !config.allowedOrigins.includes(origin)) {
            rpcError(res, 403, `Origin not allowed: ${origin}`);
            return;
        }
        next();
    });

    /** Resolve the bearer token for this request, or respond 401 and return undefined. */
    const requireAuth = (req: Request, res: Response): { token: string } | undefined => {
        if (config.authMode === 'env') {
            return { token: '' };
        }
        const header = req.headers.authorization || '';
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="appmixer-mcp"');
            rpcError(res, 401,
                'Missing Authorization header. Connect with "Authorization: Bearer <your Appmixer access token>".');
            return undefined;
        }
        return { token: match[1] };
    };

    const getSession = (req: Request, res: Response, tokenHash: string): Session | undefined | null => {
        const sessionId = req.headers['mcp-session-id'];
        if (typeof sessionId !== 'string') return null; // No session header at all.
        const session = sessions.get(sessionId);
        if (!session) {
            rpcError(res, 404, 'Unknown or expired MCP session. Reinitialize the connection.');
            return undefined;
        }
        if (!safeEqual(session.tokenHash, tokenHash)) {
            rpcError(res, 401, 'Session does not belong to this credential.');
            return undefined;
        }
        session.lastSeen = Date.now();
        return session;
    };

    app.post('/mcp', (req, res) => {
        void (async () => {
            const auth = requireAuth(req, res);
            if (!auth) return;
            const tokenHash = auth.token ? hashToken(auth.token) : '';

            const existing = getSession(req, res, tokenHash);
            if (existing === undefined) return; // Error already sent.
            if (existing) {
                await existing.transport.handleRequest(req, res, req.body);
                return;
            }

            if (!isInitializeRequest(req.body)) {
                rpcError(res, 400, 'Bad Request: send an initialize request to start an MCP session.');
                return;
            }

            if (rateLimited(req.ip || req.socket.remoteAddress || 'unknown')) {
                res.setHeader('Retry-After', '60');
                rpcError(res, 429, 'Too many session attempts. Retry in a minute.');
                return;
            }
            if (sessions.size >= config.maxSessions) {
                res.setHeader('Retry-After', '60');
                rpcError(res, 429,
                    `Server at capacity (${config.maxSessions} sessions). Retry later.`);
                return;
            }
            // A credential the tenant just rejected is refused locally, so a
            // retry loop cannot be amplified into upstream traffic.
            const rejectedAt = tokenHash ? rejectedTokens.get(tokenHash) : undefined;
            if (rejectedAt && rejectedAt > Date.now() - REJECTED_TOKEN_TTL_MS) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="appmixer-mcp"');
                rpcError(res, 401, 'Appmixer rejected this access token.');
                return;
            }

            // New session. In bearer mode the Appmixer client is bound to the
            // caller's token; in env mode it uses the server-level credentials.
            const sessionConfig = config.authMode === 'bearer'
                ? { ...config, accessToken: auth.token, username: undefined, password: undefined }
                : config;
            const serverApp = createAppmixerServer(sessionConfig, log);

            // Verify the credential with the tenant before building any session
            // state: an unchecked token would otherwise buy an anonymous caller
            // a full session, including its background gateway polling.
            if (config.authMode === 'bearer') {
                try {
                    await serverApp.client.getCurrentUser();
                } catch (err) {
                    serverApp.stop();
                    const status = err instanceof ApiError ? err.status : undefined;
                    if (status === 401 || status === 403) {
                        rejectedTokens.set(tokenHash, Date.now());
                        res.setHeader('WWW-Authenticate', 'Bearer realm="appmixer-mcp"');
                        rpcError(res, 401, 'Appmixer rejected this access token. ' +
                            'Provide a valid token for this tenant in the Authorization header.');
                    } else {
                        rpcError(res, 502, `Could not verify the token with Appmixer: ${describeError(err)}`);
                    }
                    return;
                }
            }
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId) => {
                    sessions.set(sessionId, {
                        transport, app: serverApp, tokenHash, lastSeen: Date.now()
                    });
                    log(`MCP session ${sessionId} initialized (${sessions.size} active).`);
                }
            });
            transport.onclose = () => {
                serverApp.stop();
                if (transport.sessionId) sessions.delete(transport.sessionId);
            };

            await serverApp.start();
            await serverApp.server.connect(transport);
            await transport.handleRequest(req, res, req.body);

            // If the SDK rejected the initialize request (bad Accept header,
            // unsupported protocol version), onsessioninitialized never fired:
            // the session is in no map, transport.onclose will not run, and the
            // started gateway manager would keep its timers forever.
            if (!transport.sessionId || !sessions.has(transport.sessionId)) {
                serverApp.stop();
                await transport.close().catch(() => undefined);
            }
        })().catch(err => {
            log('Unhandled /mcp error.', err);
            if (!res.headersSent) rpcError(res, 500, 'Internal server error.');
        });
    });

    // GET = server->client notification stream, DELETE = session termination.
    const handleSessionRequest = (req: Request, res: Response) => {
        void (async () => {
            const auth = requireAuth(req, res);
            if (!auth) return;
            const tokenHash = auth.token ? hashToken(auth.token) : '';
            const session = getSession(req, res, tokenHash);
            if (!session) {
                if (session === null) rpcError(res, 400, 'Missing Mcp-Session-Id header.');
                return;
            }
            await session.transport.handleRequest(req, res);
        })().catch(err => {
            log('Unhandled /mcp error.', err);
            if (!res.headersSent) rpcError(res, 500, 'Internal server error.');
        });
    };
    app.get('/mcp', handleSessionRequest);
    app.delete('/mcp', handleSessionRequest);

    return {
        app,
        close() {
            clearInterval(sweepTimer);
            for (const session of sessions.values()) {
                void session.transport.close();
            }
            sessions.clear();
            attempts.clear();
            rejectedTokens.clear();
        }
    };
}
