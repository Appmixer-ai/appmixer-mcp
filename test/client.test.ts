import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppmixerClient } from '../src/client.js';
import { ApiError } from '../src/errors.js';
import { futureJwt, expiredJwt, jsonResponse } from './helpers.js';

const BASE_URL = 'https://api.tenant.appmixer.cloud';

describe('AppmixerClient', () => {

    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends Bearer token and builds query strings', async () => {
        const token = futureJwt();
        fetchMock.mockResolvedValueOnce(jsonResponse([{ flowId: 'f1' }]));
        const client = new AppmixerClient({ baseUrl: BASE_URL, accessToken: token });

        const flows = await client.getFlows({ pattern: 'a b', limit: 5 });

        expect(flows).toEqual([{ flowId: 'f1' }]);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain(`${BASE_URL}/flows?`);
        expect(url).toContain('pattern=a+b');
        expect(url).toContain('limit=5');
        expect(url).toContain('projection=-thumbnail');
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    });

    it('re-authenticates when the token is expired and credentials are available', async () => {
        const fresh = futureJwt();
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ token: fresh }))       // POST /user/auth
            .mockResolvedValueOnce(jsonResponse({ flowId: 'f1' }));      // GET /flows/f1
        const client = new AppmixerClient({
            baseUrl: BASE_URL, accessToken: expiredJwt(),
            username: 'u@example.com', password: 'secret'
        });

        await client.getFlow('f1');

        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/user/auth`);
        expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization)
            .toBe(`Bearer ${fresh}`);
    });

    it('retries once with a fresh token on 401', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 401)) // first attempt
            .mockResolvedValueOnce(jsonResponse({ token: futureJwt() }))           // re-login
            .mockResolvedValueOnce(jsonResponse({ ok: true }));                    // retry
        const client = new AppmixerClient({
            baseUrl: BASE_URL, accessToken: futureJwt(),
            username: 'u@example.com', password: 'secret'
        });

        await expect(client.getFlow('f1')).resolves.toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws ApiError with status, method and url on failure', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 404));
        const client = new AppmixerClient({ baseUrl: BASE_URL, accessToken: futureJwt() });

        const error = await client.getFlow('missing').catch(err => err) as ApiError;

        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(404);
        expect(error.method).toBe('GET');
        expect(error.url).toBe(`${BASE_URL}/flows/missing`);
        expect(error.body).toEqual({ message: 'nope' });
    });

    it('fails fast when the token is expired and no credentials exist', async () => {
        const client = new AppmixerClient({ baseUrl: BASE_URL, accessToken: 'not-a-jwt' });
        // Token is not decodable => not usable, no way to re-auth: expect the API-side 401 path.
        fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 401));
        const error = await client.getFlow('f1').catch(err => err) as ApiError;
        expect(error.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1); // No retry without credentials.
    });

    it('supports absolute webhook URLs for gateway tools', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse('done'));
        const client = new AppmixerClient({ baseUrl: BASE_URL, accessToken: futureJwt() });

        await client.callGatewayTool('https://other.example.com/hook', 'tool_x', { a: 1 });

        expect(fetchMock.mock.calls[0][0]).toBe('https://other.example.com/hook');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            function: { name: 'tool_x', arguments: { a: 1 } }
        });
    });

    it('shares a single in-flight login between concurrent requests', async () => {
        let resolveLogin!: (value: Response) => void;
        fetchMock
            .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveLogin = resolve; }))
            .mockImplementation(() => Promise.resolve(jsonResponse({})));
        const client = new AppmixerClient({
            baseUrl: BASE_URL, username: 'u@example.com', password: 'secret'
        });

        const requests = Promise.all([client.getFlow('a'), client.getFlow('b')]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        resolveLogin(jsonResponse({ token: futureJwt() }));
        await requests;

        const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/user/auth'));
        expect(loginCalls).toHaveLength(1);
    });
});
