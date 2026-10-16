export class ApiError extends Error {

    constructor(
        message: string,
        public readonly status: number | undefined,
        public readonly method: string,
        public readonly url: string,
        public readonly body?: unknown
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

const HINTS: Record<number, string> = {
    401: 'The access token is invalid or expired. Renew APPMIXER_ACCESS_TOKEN or set APPMIXER_USERNAME/APPMIXER_PASSWORD so the server can re-authenticate.',
    403: 'The authenticated user does not have permission for this operation.',
    404: 'The resource was not found. Check that the ID is correct and belongs to this user.',
    429: 'Rate limited by the Appmixer API. Retry later.'
};

/** Turn any error into an actionable, single-string tool error message. */
export function describeError(err: unknown): string {

    if (err instanceof ApiError) {
        const hint = err.status ? HINTS[err.status] : undefined;
        const detail = typeof err.body === 'object' && err.body !== null && 'message' in err.body
            ? ` Server says: ${(err.body as { message: string }).message}`
            : '';
        return `Appmixer API error${err.status ? ` ${err.status}` : ''} on ${err.method} ${err.url}.` +
            `${detail}${hint ? ` ${hint}` : ''}`;
    }
    if (err instanceof Error) {
        return `${err.name}: ${err.message}`;
    }
    return String(err);
}
