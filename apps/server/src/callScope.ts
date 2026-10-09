import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-call state for the code below a tool handler. This module is its only
 * home. Facts a handler needs to see stay in `ToolCallContext`.
 *
 * `dispatchToolCall` opens it once per call; `FetchClient` and
 * `mapWithConcurrency` read it and stop work for a call that has been
 * cancelled. Work meant to outlive a call must not start inside one.
 */
export interface CallScope {
  /**
   * Aborts when the client cancels the call, the call times out or the
   * client disconnects, an SSE stream is cancelled, or the server shuts down.
   * It aborts again once the response is written. Absent means the call
   * cannot be cancelled.
   */
  readonly signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<CallScope>();

/** Runs `fn` with `scope` as the current call's scope, across every await in it. */
export function runInCallScope<T>(scope: CallScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The current call's cancel signal, or `undefined` outside a call or for an uncancellable one. */
export function currentCallSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/** Thrown when work stops because its tool call was cancelled. */
export class CallCancelledError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`${what} stopped: the tool call was cancelled.`, options);
    this.name = "CallCancelledError";
  }
}

/** Throws a {@link CallCancelledError} when `signal` has aborted. `what` names the work that stops. */
export function throwIfCancelled(
  signal: AbortSignal | undefined,
  what: string,
): void {
  if (signal?.aborted) {
    throw new CallCancelledError(what, { cause: signal.reason });
  }
}
