/** Fabricate an unsigned JWT with the given payload (client only decodes, never verifies). */
export function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

export function futureJwt(secondsFromNow = 3600): string {
    return fakeJwt({ exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'user1' });
}

export function expiredJwt(): string {
    return fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60, sub: 'user1' });
}

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
