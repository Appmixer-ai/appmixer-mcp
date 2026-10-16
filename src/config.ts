export interface Config {
    baseUrl: string;
    accessToken?: string;
    username?: string;
    password?: string;
    /** Enabled tool groups: 'api', 'mcpgateway'. */
    tools: Set<string>;
}

export class ConfigError extends Error {}

export type HttpAuthMode = 'env' | 'bearer';

export interface HttpConfig extends Config {
    port: number;
    host: string;
    /** Origin header allowlist; requests with an Origin not listed here are rejected. */
    allowedOrigins: string[];
    authMode: HttpAuthMode;
    /** Idle session lifetime in milliseconds. */
    sessionIdleMs: number;
    /** Refuse new sessions above this many concurrent ones. */
    maxSessions: number;
    /** Session-creation attempts allowed per client address per minute (0 = unlimited). */
    rateLimitPerMinute: number;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {

    const authModeRaw = (env.MCP_AUTH_MODE || '').trim().toLowerCase();
    if (authModeRaw && authModeRaw !== 'env' && authModeRaw !== 'bearer') {
        throw new ConfigError(`MCP_AUTH_MODE must be "env" or "bearer", got "${authModeRaw}".`);
    }

    const hasEnvCredentials = Boolean(
        env.APPMIXER_ACCESS_TOKEN?.trim() || (env.APPMIXER_USERNAME?.trim() && env.APPMIXER_PASSWORD));
    const authMode: HttpAuthMode = (authModeRaw as HttpAuthMode)
        || (hasEnvCredentials ? 'env' : 'bearer');

    const base = loadConfig(env, { requireCredentials: authMode === 'env' });

    // Explicit configuration wins; PORT is the fallback platforms inject.
    const port = Number(env.MCP_HTTP_PORT || env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`Invalid port: ${env.MCP_HTTP_PORT || env.PORT}`);
    }
    const sessionIdleSeconds = Number(env.MCP_SESSION_IDLE_TIMEOUT || 4 * 3600);
    if (!Number.isFinite(sessionIdleSeconds) || sessionIdleSeconds < 60) {
        throw new ConfigError('MCP_SESSION_IDLE_TIMEOUT must be at least 60 (seconds).');
    }

    const maxSessions = Number(env.MCP_MAX_SESSIONS || 200);
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
        throw new ConfigError('MCP_MAX_SESSIONS must be a positive integer.');
    }
    const rateLimitPerMinute = Number(env.MCP_RATE_LIMIT_PER_MINUTE ?? 30);
    if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 0) {
        throw new ConfigError('MCP_RATE_LIMIT_PER_MINUTE must be 0 (unlimited) or a positive integer.');
    }

    return {
        ...base,
        port,
        host: env.MCP_HTTP_HOST || '127.0.0.1',
        allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '')
            .split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean),
        authMode,
        sessionIdleMs: sessionIdleSeconds * 1000,
        maxSessions,
        rateLimitPerMinute
    };
}

/**
 * MCPB hosts substitute `${user_config.*}` placeholders into the environment.
 * An optional field the user left blank can arrive as the literal placeholder,
 * which must be read as "not set" rather than as a credential.
 */
function envValue(raw: string | undefined, { trim = true } = {}): string | undefined {
    const value = trim ? raw?.trim() : raw;
    if (!value || /^\$\{[^}]*\}$/.test(value.trim())) return undefined;
    return value;
}

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
    options: { requireCredentials?: boolean } = {}
): Config {

    const baseUrl = (envValue(env.APPMIXER_BASE_URL) || '').replace(/\/+$/, '');
    if (!baseUrl) {
        throw new ConfigError(
            'APPMIXER_BASE_URL is required. Example: https://api.YOUR_TENANT.appmixer.cloud');
    }
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error();
        }
    } catch {
        throw new ConfigError(`APPMIXER_BASE_URL is not a valid URL: ${baseUrl}`);
    }

    const accessToken = envValue(env.APPMIXER_ACCESS_TOKEN);
    const username = envValue(env.APPMIXER_USERNAME);
    const password = envValue(env.APPMIXER_PASSWORD, { trim: false });

    if (options.requireCredentials !== false && !accessToken && !(username && password)) {
        throw new ConfigError(
            'Either APPMIXER_ACCESS_TOKEN or APPMIXER_USERNAME + APPMIXER_PASSWORD must be set.');
    }

    const tools = new Set(
        (envValue(env.TOOLS) || 'api,mcpgateway')
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(Boolean)
    );

    return { baseUrl, accessToken, username, password, tools };
}
