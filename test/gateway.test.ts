import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { GatewayManager, sanitizeToolName, uniqueName } from '../src/tools/gateway.js';
import type { Logger } from '../src/tools/gateway.js';
import type { AppmixerClient } from '../src/client.js';
import { ApiError } from '../src/errors.js';
import { jsonSchemaToZod } from '../src/tools/json-schema-to-zod.js';

describe('sanitizeToolName', () => {

    it('replaces invalid characters and enforces the 64-char limit', () => {
        expect(sanitizeToolName('my tool (v2)!')).toBe('my_tool__v2__');
        expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64);
        expect(sanitizeToolName('')).toBe('tool');
    });
});

describe('uniqueName', () => {

    it('suffixes duplicates while keeping the length limit', () => {
        const taken = new Set(['dup', 'dup_2']);
        expect(uniqueName('fresh', taken)).toBe('fresh');
        expect(uniqueName('dup', taken)).toBe('dup_3');
        const long = 'y'.repeat(64);
        const result = uniqueName(long, new Set([long]));
        expect(result).toHaveLength(64);
        expect(result.endsWith('_2')).toBe(true);
    });
});

describe('jsonSchemaToZod', () => {

    const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The name.' },
            count: { type: 'integer' },
            enabled: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            level: { type: 'string', enum: ['low', 'high'] },
            nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }
        },
        required: ['name']
    });

    it('validates conforming input', () => {
        const parsed = schema.safeParse({
            name: 'a', count: 3, enabled: true, tags: ['t'], level: 'low', nested: { x: 1.5 }
        });
        expect(parsed.success).toBe(true);
    });

    it('enforces required fields and types', () => {
        expect(schema.safeParse({}).success).toBe(false);                      // missing name
        expect(schema.safeParse({ name: 'a', count: 'NaN' }).success).toBe(false);
        expect(schema.safeParse({ name: 'a', level: 'medium' }).success).toBe(false);
    });

    it('is loose about undeclared properties', () => {
        expect(schema.safeParse({ name: 'a', extra: 42 }).success).toBe(true);
    });

    it('degrades to unknown for unrecognized schemas', () => {
        const anything = jsonSchemaToZod({ type: 'weird' });
        expect(anything.safeParse({ whatever: true }).success).toBe(true);
    });

    it('returns an object schema even for empty parameters', () => {
        const empty = jsonSchemaToZod(undefined);
        expect(empty).toBeInstanceOf(z.ZodType);
        expect(empty.safeParse({}).success).toBe(true);
    });
});

describe('GatewayManager.refresh', () => {

    /** Minimal McpServer stand-in: records registrations and removals. */
    function fakeServer() {
        const tools = new Map<string, { config: Record<string, unknown>; removed: boolean }>();
        return {
            tools,
            registerTool(name: string, config: Record<string, unknown>) {
                const entry = { config, removed: false };
                tools.set(name, entry);
                return { remove: () => { entry.removed = true; tools.delete(name); } };
            }
        };
    }

    function gateway(webhook: string, ...names: string[]) {
        return {
            webhook,
            tools: names.map(name => ({
                type: 'function',
                function: { name, description: `does ${name}`, parameters: { type: 'object', properties: {} } }
            }))
        };
    }

    /** A manager wired to a fake server and a client whose getGateways is scripted. */
    function managerWith(getGateways: () => unknown, log: Logger = () => {}) {
        const server = fakeServer();
        const client = { getGateways } as unknown as AppmixerClient;
        const manager = new GatewayManager(server as never, client, log);
        return { manager, server };
    }

    it('registers one tool per gateway tool, titled after the name suffix', async () => {
        const { manager, server } = managerWith(async () => [gateway('https://hook/1', 'abc123_SendEmail')]);

        expect(await manager.refresh()).toBe(true);
        expect([...server.tools.keys()]).toEqual(['abc123_SendEmail']);
        expect(server.tools.get('abc123_SendEmail')?.config.title).toBe('SendEmail');
    });

    it('keeps an unchanged tool registered but re-registers a changed definition', async () => {
        let description = 'first';
        const { manager, server } = managerWith(async () => [{
            webhook: 'https://hook/1',
            tools: [{ type: 'function', function: { name: 'tool_a', description, parameters: { type: 'object' } } }]
        }]);

        await manager.refresh();
        const first = server.tools.get('tool_a');
        await manager.refresh();
        // Same fingerprint: the registration object must be the very same one,
        // otherwise clients get a pointless tools/list_changed on every refresh.
        expect(server.tools.get('tool_a')).toBe(first);

        description = 'second';
        await manager.refresh();
        expect(server.tools.get('tool_a')).not.toBe(first);
        expect(first?.removed).toBe(true);
        expect(server.tools.get('tool_a')?.config.description).toBe('second');
    });

    it('removes tools of a gateway that disappeared', async () => {
        let gateways = [gateway('https://hook/1', 'tool_a'), gateway('https://hook/2', 'tool_b')];
        const { manager, server } = managerWith(async () => gateways);

        await manager.refresh();
        expect([...server.tools.keys()]).toEqual(['tool_a', 'tool_b']);

        gateways = [gateway('https://hook/1', 'tool_a')];
        await manager.refresh();
        expect([...server.tools.keys()]).toEqual(['tool_a']);
    });

    it('disambiguates tools that sanitize to the same name', async () => {
        const { manager, server } = managerWith(async () =>
            [gateway('https://hook/1', 'same tool', 'same/tool')]);

        await manager.refresh();
        expect([...server.tools.keys()]).toEqual(['same_tool', 'same_tool_2']);
    });

    it('skips tools without a name and gateways without a webhook', async () => {
        const { manager, server } = managerWith(async () => [
            { webhook: 'https://hook/1', tools: [{ type: 'function', function: { description: 'nameless' } }] },
            { tools: [{ type: 'function', function: { name: 'orphan' } }] },
            gateway('https://hook/2', 'usable')
        ]);

        await manager.refresh();
        expect([...server.tools.keys()]).toEqual(['usable']);
    });

    it('reports the plugin as unavailable on 404 and keeps no tools', async () => {
        const messages: string[] = [];
        const { manager, server } = managerWith(
            async () => { throw new ApiError('not found', 404, 'GET', '/plugins'); },
            message => messages.push(message));

        expect(await manager.refresh()).toBe(false);
        expect(server.tools.size).toBe(0);
        expect(messages.join(' ')).toContain('not installed');
        manager.stop();
    });

    it('disables itself for good once the tenant rejects the credentials', async () => {
        let calls = 0;
        const { manager } = managerWith(async () => {
            calls++;
            throw new ApiError('forbidden', 403, 'GET', '/plugins');
        });

        expect(await manager.refresh()).toBe(false);
        expect(await manager.refresh()).toBe(false);
        // A disabled manager must not keep calling the API for the session's lifetime.
        expect(calls).toBe(1);
    });

    it('keeps previously registered tools when a refresh fails for another reason', async () => {
        let fail = false;
        const { manager, server } = managerWith(async () => {
            if (fail) throw new ApiError('boom', 500, 'GET', '/plugins');
            return [gateway('https://hook/1', 'tool_a')];
        });

        await manager.refresh();
        fail = true;
        // A tenant hiccup must not strip the client's tools.
        expect(await manager.refresh()).toBe(true);
        expect([...server.tools.keys()]).toEqual(['tool_a']);
    });

    it('registers nothing after stop()', async () => {
        const { manager, server } = managerWith(async () => [gateway('https://hook/1', 'tool_a')]);

        manager.stop();
        expect(await manager.refresh()).toBe(false);
        expect(server.tools.size).toBe(0);
    });
});
