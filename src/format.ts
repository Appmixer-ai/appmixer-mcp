import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { withCallSignal } from './cancellation.js';
import { describeError } from './errors.js';

export const MAX_RESULT_CHARS = 20_000;

export function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n… [truncated, ${text.length - max} characters omitted]`;
}

export function textResult(value: unknown, maxChars = MAX_RESULT_CHARS): CallToolResult {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text: truncate(text, maxChars) }] };
}

export function errorResult(err: unknown): CallToolResult {
    return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
}

/** Extra argument the SDK passes to a tool handler; only the signal concerns us. */
interface HandlerExtra {
    signal?: AbortSignal;
}

/**
 * Wrap a tool handler so any thrown error becomes an actionable isError result,
 * and the client's cancellation signal reaches the HTTP layer (see
 * `cancellation.ts`) without every handler having to pass it along.
 */
export function safeHandler<A>(
    handler: (args: A) => Promise<CallToolResult>
): (args: A, extra?: HandlerExtra) => Promise<CallToolResult> {
    return async (args: A, extra?: HandlerExtra) => {
        try {
            return await withCallSignal(extra?.signal, () => handler(args));
        } catch (err) {
            if (extra?.signal?.aborted) {
                return errorResult(new Error('The call was cancelled by the client.'));
            }
            return errorResult(err);
        }
    };
}
