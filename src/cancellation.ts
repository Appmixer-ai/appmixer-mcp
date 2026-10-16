import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Carries the current tool call's AbortSignal from the MCP layer down to the
 * HTTP client. Passing it explicitly would mean threading a parameter through
 * every tool handler and every client method; the request-scoped store keeps
 * the tool code unchanged while still honouring cancellation everywhere.
 */
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/** Run a tool handler with the client's cancellation signal in scope. */
export function withCallSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
    return callSignal.run(signal, run);
}

/** The signal of the tool call currently being handled, if any. */
export function currentCallSignal(): AbortSignal | undefined {
    return callSignal.getStore();
}

/**
 * Combine the caller's cancellation with a request timeout. Returns the
 * timeout's controller so the caller can clear it, plus the effective signal.
 */
export function withTimeout(timeoutMs: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const caller = currentCallSignal();
    const signal = caller ? AbortSignal.any([controller.signal, caller]) : controller.signal;
    return { signal, done: () => clearTimeout(timer) };
}
