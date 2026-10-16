import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const BASE = { APPMIXER_BASE_URL: 'https://api.tenant.appmixer.cloud', APPMIXER_ACCESS_TOKEN: 'token' };

describe('loadConfig', () => {

    it('requires APPMIXER_BASE_URL', () => {
        expect(() => loadConfig({})).toThrow(ConfigError);
    });

    it('rejects invalid URLs', () => {
        expect(() => loadConfig({ APPMIXER_BASE_URL: 'not a url', APPMIXER_ACCESS_TOKEN: 't' }))
            .toThrow(/not a valid URL/);
    });

    it('requires token or username+password', () => {
        expect(() => loadConfig({ APPMIXER_BASE_URL: BASE.APPMIXER_BASE_URL }))
            .toThrow(/ACCESS_TOKEN or/);
        expect(() => loadConfig({
            APPMIXER_BASE_URL: BASE.APPMIXER_BASE_URL,
            APPMIXER_USERNAME: 'user@example.com'
        })).toThrow(ConfigError);
    });

    it('strips trailing slashes from the base URL', () => {
        const config = loadConfig({ ...BASE, APPMIXER_BASE_URL: `${BASE.APPMIXER_BASE_URL}//` });
        expect(config.baseUrl).toBe(BASE.APPMIXER_BASE_URL);
    });

    it('defaults TOOLS to api,mcpgateway', () => {
        const config = loadConfig(BASE);
        expect(config.tools).toEqual(new Set(['api', 'mcpgateway']));
    });

    it('parses a custom TOOLS list', () => {
        const config = loadConfig({ ...BASE, TOOLS: 'API' });
        expect(config.tools).toEqual(new Set(['api']));
    });

    it('keeps the reported version in step with package.json', async () => {
        const [{ VERSION }, pkg] = await Promise.all([
            import('../src/version.js'),
            import('../package.json', { with: { type: 'json' } })
        ]);
        expect(VERSION).toBe((pkg.default as { version: string }).version);
    });

    it('ignores unsubstituted MCPB placeholders', () => {
        // An optional user_config field left blank can reach us as the literal
        // "${user_config.x}" placeholder; it must not be taken for a value.
        const config = loadConfig({
            APPMIXER_BASE_URL: BASE.APPMIXER_BASE_URL,
            APPMIXER_ACCESS_TOKEN: '${user_config.access_token}',
            APPMIXER_USERNAME: 'user@example.com',
            APPMIXER_PASSWORD: 'secret',
            TOOLS: '${user_config.tools}'
        });
        expect(config.accessToken).toBeUndefined();
        expect(config.username).toBe('user@example.com');
        expect(config.tools).toEqual(new Set(['api', 'mcpgateway']));
    });

    it('still requires real credentials when every value is a placeholder', () => {
        expect(() => loadConfig({
            APPMIXER_BASE_URL: BASE.APPMIXER_BASE_URL,
            APPMIXER_ACCESS_TOKEN: '${user_config.access_token}',
            APPMIXER_USERNAME: '${user_config.username}',
            APPMIXER_PASSWORD: '${user_config.password}'
        })).toThrow(ConfigError);
    });
});
