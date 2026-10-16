import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { safeHandler, textResult, truncate } from '../format.js';

/**
 * Tools for the data a flow works with rather than the flow itself: data
 * stores, flow version snapshots and the modifier catalogue.
 */
export function registerDataTools(server: McpServer, client: AppmixerClient): void {

    // ---- Data stores ----------------------------------------------------

    server.registerTool('list_stores', {
        title: 'List Data Stores',
        description: 'List the user\'s Appmixer data stores. Flows read and write these through ' +
            'the appmixer.utils.storage components, which need the store\'s ID — look it up here ' +
            'rather than guessing it.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safeHandler(async () => {
        const stores = await client.listStores();
        return textResult({ count: stores.length, stores });
    }));

    server.registerTool('create_store', {
        title: 'Create Data Store',
        description: 'Create a data store the flows of this user can read and write.',
        inputSchema: { name: z.string().min(1).describe('Name of the new store.') },
        annotations: { destructiveHint: false }
    }, safeHandler(async ({ name }) => {
        return textResult(await client.createStore(name));
    }));

    server.registerTool('get_store_records', {
        title: 'Get Data Store Records',
        description: 'Read records of a data store: their keys, values and timestamps. Use it to ' +
            'see what a flow has stored, or to check the data a flow is about to read.',
        inputSchema: {
            store_id: z.string().min(1).describe('The ID of the store (see list_stores).'),
            limit: z.number().int().min(1).max(100).default(20),
            offset: z.number().int().min(0).default(0)
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ store_id, limit, offset }) => {
        const [records, total] = await Promise.all([
            client.getStoreRecords(store_id, { limit, offset }),
            client.getStoreRecordCount(store_id).catch(() => ({ count: undefined }))
        ]);
        const rows = records.map(record => ({
            key: record.key,
            value: record.value,
            updatedAt: record.updatedAt
        }));
        return textResult({ total: total.count, returned: rows.length, offset, records: rows });
    }));

    server.registerTool('set_store_record', {
        title: 'Set Data Store Record',
        description: 'Create or overwrite one record of a data store. `value` is stored as it is, ' +
            'so wrap a scalar in an object, e.g. {"value": "text"}. Useful for seeding data a ' +
            'flow will read, or correcting a record a flow wrote.',
        inputSchema: {
            store_id: z.string().min(1).describe('The ID of the store.'),
            key: z.string().min(1).describe('Record key; an existing key is overwritten.'),
            value: z.record(z.string(), z.unknown()).describe('The value object to store.')
        },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ store_id, key, value }) => {
        return textResult(await client.setStoreRecord(store_id, key, value));
    }));

    server.registerTool('delete_store_record', {
        title: 'Delete Data Store Record',
        description: 'Delete one record from a data store. This cannot be undone.',
        inputSchema: {
            store_id: z.string().min(1).describe('The ID of the store.'),
            key: z.string().min(1).describe('The key to delete.')
        },
        annotations: { destructiveHint: true }
    }, safeHandler(async ({ store_id, key }) => {
        await client.deleteStoreRecord(store_id, key);
        return textResult(`Record "${key}" deleted from store ${store_id}.`);
    }));

    // ---- Flow versions --------------------------------------------------

    server.registerTool('list_flow_versions', {
        title: 'List Flow Versions',
        description: 'List saved versions of a flow, newest first. Versions are snapshots the ' +
            'flow can be rolled back to.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            limit: z.number().int().min(1).max(100).default(20),
            offset: z.number().int().min(0).default(0)
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, limit, offset }) => {
        const result = await client.listFlowVersions(id, { limit, offset });
        const rows = (result.items || []).map(version => ({
            versionId: version.versionId,
            versionNumber: version.versionNumber,
            type: version.type,
            label: version.label,
            created: version.btime
        }));
        return textResult({ total: result.totalCount, returned: rows.length, versions: rows });
    }));

    server.registerTool('create_flow_version', {
        title: 'Create Flow Version',
        description: 'Snapshot the current state of a flow so it can be restored later. Take one ' +
            'before rewriting a flow you did not build — update_flow replaces the descriptor and ' +
            'there is no undo otherwise.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            label: z.string().max(255).optional().describe('Label for the snapshot, e.g. "before adding Slack step".')
        },
        annotations: { destructiveHint: false }
    }, safeHandler(async ({ id, label }) => {
        return textResult(await client.createFlowVersion(id, label));
    }));

    server.registerTool('restore_flow_version', {
        title: 'Restore Flow Version',
        description: 'Roll a flow back to a saved version. The flow\'s current descriptor is ' +
            'replaced by the snapshot, so take a version of the current state first if you may ' +
            'want it back.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            version_id: z.string().min(1).describe('The ID of the version (see list_flow_versions).')
        },
        annotations: { destructiveHint: true }
    }, safeHandler(async ({ id, version_id }) => {
        return textResult(await client.restoreFlowVersion(id, version_id));
    }));

    server.registerTool('clone_flow', {
        title: 'Clone Flow',
        description: 'Copy a flow, including its components and wiring. The copy is created ' +
            'stopped and its components have no accounts assigned unless connect_accounts is set. ' +
            'Cloning then editing the copy is the safe way to change a flow that is in use.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow to copy.'),
            prefix: z.string().optional().describe('Prefix for the copy\'s name, e.g. "Copy of ".'),
            connect_accounts: z.boolean().default(false)
                .describe('Carry the original\'s connected accounts over to the copy.')
        },
        annotations: { destructiveHint: false }
    }, safeHandler(async ({ id, prefix, connect_accounts }) => {
        const body: Record<string, unknown> = {};
        if (prefix !== undefined) body.prefix = prefix;
        if (connect_accounts) body.connectAccounts = true;
        // The API answers with { cloneId }; report it as a flow ID so the
        // caller can use it with the flow tools without translating.
        const result = await client.cloneFlow(id, body) as { cloneId?: string; flowId?: string };
        return textResult({
            flowId: result.cloneId ?? result.flowId,
            clonedFrom: id
        });
    }));

    // ---- Modifier catalogue ---------------------------------------------

    server.registerTool('list_modifiers', {
        title: 'List Modifiers',
        description: 'List the modifier functions available on this tenant — the `g_*` functions ' +
            'usable in a transform\'s `functions` array (g_length, g_jsonPath, g_formatDate …). ' +
            'Check here instead of assuming a function exists.',
        inputSchema: {
            category: z.string().optional()
                .describe('Filter by category, e.g. "text", "list", "date", "number", "object".'),
            search: z.string().optional().describe('Filter by name or description substring.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ category, search }) => {
        const catalogue = await client.getModifiers();
        const needle = search?.toLowerCase();
        const rows = Object.entries(catalogue.modifiers || {})
            .map(([name, entry]) => ({
                name,
                label: entry.label,
                categories: entry.category,
                description: typeof entry.description === 'string'
                    ? truncate(entry.description, 200) : entry.description
            }))
            .filter(row => !category
                || (Array.isArray(row.categories) && row.categories.includes(category)))
            .filter(row => !needle
                || row.name.toLowerCase().includes(needle)
                || String(row.description ?? '').toLowerCase().includes(needle));
        return textResult({
            count: rows.length,
            categories: Object.keys(catalogue.categories || {}),
            modifiers: rows
        });
    }));
}
