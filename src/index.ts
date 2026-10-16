#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ConfigError } from './config.js';
import { createAppmixerServer } from './server.js';

// stdio transport: stdout belongs to the protocol, all logging goes to stderr.
const log = (message: string, detail?: unknown) => {
    console.error(`[appmixer-mcp] ${message}`, detail !== undefined ? detail : '');
};

async function main(): Promise<void> {

    let config;
    try {
        config = loadConfig();
    } catch (err) {
        if (err instanceof ConfigError) {
            console.error(`[appmixer-mcp] Configuration error: ${err.message}`);
            process.exit(1);
        }
        throw err;
    }

    const app = createAppmixerServer(config, log);

    process.on('SIGINT', () => { app.stop(); process.exit(0); });
    process.on('SIGTERM', () => { app.stop(); process.exit(0); });

    await app.start();

    const transport = new StdioServerTransport();
    await app.server.connect(transport);
    log(`Server running (tools: ${[...config.tools].join(', ')}).`);
}

main().catch(err => {
    console.error('[appmixer-mcp] Fatal error:', err);
    process.exit(1);
});
