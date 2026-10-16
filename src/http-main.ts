#!/usr/bin/env node
import { loadHttpConfig, ConfigError } from './config.js';
import { createHttpApp } from './http.js';

const log = (message: string, detail?: unknown) => {
    console.error(`[appmixer-mcp-http] ${message}`, detail !== undefined ? detail : '');
};

let config;
try {
    config = loadHttpConfig();
} catch (err) {
    if (err instanceof ConfigError) {
        console.error(`[appmixer-mcp-http] Configuration error: ${err.message}`);
        process.exit(1);
    }
    throw err;
}

const { app, close } = createHttpApp(config, log);

const server = app.listen(config.port, config.host, () => {
    log(`Listening on http://${config.host}:${config.port}/mcp ` +
        `(auth: ${config.authMode}, tools: ${[...config.tools].join(', ')})`);
    if (config.authMode === 'env') {
        log('WARNING: env auth mode serves ONE Appmixer user to every caller. ' +
            'Do not expose this mode publicly; use MCP_AUTH_MODE=bearer for multi-user setups.');
    }
});

const shutdown = () => {
    close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
