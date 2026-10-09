import { describe, expect, it } from "vitest";
import {
  CallCancelledError,
  type CallFailure,
  type CallScope,
  currentCallSignal,
  noteCallFailure,
  runInCallScope,
  throwIfCancelled,
} from "./callScope";

describe("currentCallSignal", () => {
  it("is undefined outside a scope", () => {
    expect(currentCallSignal()).toBeUndefined();
  });

  it("is undefined inside a scope that has no signal", () => {
    expect(runInCallScope({}, () => currentCallSignal())).toBeUndefined();
  });

  it("survives await, setTimeout and nested async calls", async () => {
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const nested = async () => {
      await Promise.resolve();
      seen.push(currentCallSignal());
    };
    await runInCallScope({ signal: ac.signal }, async () => {
      seen.push(currentCallSignal());
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      seen.push(currentCallSignal());
      await nested();
      await Promise.all([nested(), nested()]);
    });
    expect(seen).toHaveLength(5);
    for (const signal of seen) expect(signal).toBe(ac.signal);
    expect(currentCallSignal()).toBeUndefined();
  });

  it("gives two interleaved scopes their own signals", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const seen: Record<string, AbortSignal | undefined> = {};
    const run = (name: string, signal: AbortSignal, delayMs: number) =>
      runInCallScope({ signal }, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        seen[name] = currentCallSignal();
      });
    await Promise.all([run("a", a.signal, 5), run("b", b.signal, 1)]);
    expect(seen.a).toBe(a.signal);
    expect(seen.b).toBe(b.signal);
  });
});

describe("throwIfCancelled", () => {
  it("does nothing for an undefined signal", () => {
    expect(() => throwIfCancelled(undefined, "Work")).not.toThrow();
  });

  it("does nothing for a live signal", () => {
    expect(() =>
      throwIfCancelled(new AbortController().signal, "Work"),
    ).not.toThrow();
  });

  it("throws a CallCancelledError that carries the abort reason", () => {
    const reason = new Error("Connection closed");
    const ac = new AbortController();
    ac.abort(reason);
    let thrown: unknown;
    try {
      throwIfCancelled(ac.signal, "Request to https://example.test/a");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CallCancelledError);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as CallCancelledError;
    expect(error.name).toBe("CallCancelledError");
    expect(error.message).toBe(
      "Request to https://example.test/a stopped: the tool call was cancelled.",
    );
    expect(error.cause).toBe(reason);
  });

  it("keeps the default abort reason as the cause", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfCancelled(ac.signal, "Work")).toThrow(
      CallCancelledError,
    );
    try {
      throwIfCancelled(ac.signal, "Work");
    } catch (error) {
      expect((error as CallCancelledError).cause).toBe(ac.signal.reason);
    }
  });
});

describe("noteCallFailure", () => {
  it("does nothing outside a scope, and does not throw", () => {
    expect(() => noteCallFailure({ error_class: "Error" })).not.toThrow();
  });

  it("stores the failure on the scope, and the last note wins", () => {
    const scope: CallScope = {};
    runInCallScope(scope, () => {
      noteCallFailure({ error_class: "First" });
      noteCallFailure({ error_class: "HttpError", http_status: 404 });
    });
    expect(scope.failure).toEqual({
      error_class: "HttpError",
      http_status: 404,
    });
  });

  it("keeps the failures of two parallel scopes apart", async () => {
    const a: CallScope = {};
    const b: CallScope = {};
    const run = (scope: CallScope, failure: CallFailure, delayMs: number) =>
      runInCallScope(scope, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        noteCallFailure(failure);
      });
    await Promise.all([
      run(a, { error_class: "A", http_status: 404 }, 5),
      run(b, { error_class: "B", http_status: 429 }, 1),
    ]);
    expect(a.failure).toEqual({ error_class: "A", http_status: 404 });
    expect(b.failure).toEqual({ error_class: "B", http_status: 429 });
  });
});
