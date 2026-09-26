import { describe, expect, it, vi } from "vitest";
import { KeyedFetchStore } from "./keyedFetchStore";

/**
 * A fetcher whose per-key promises resolve, reject, or report progress on
 * command.
 */
function deferredFetcher() {
  const pending = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (err: Error) => void;
      onProgress: (message: string) => void;
    }
  >();
  const calls: string[] = [];

  const fetcher = (key: string, onProgress: (message: string) => void) =>
    new Promise<string>((resolve, reject) => {
      calls.push(key);
      pending.set(key, { resolve, reject, onProgress });
    });

  return {
    fetcher,
    calls,
    resolve: (key: string, value: string) => pending.get(key)?.resolve(value),
    reject: (key: string, message: string) =>
      pending.get(key)?.reject(new Error(message)),
    progress: (key: string, message: string) =>
      pending.get(key)?.onProgress(message),
  };
}

/** Let the store's awaited continuations run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("KeyedFetchStore", () => {
  it("fetches a key once and exposes its data", async () => {
    const { fetcher, calls, resolve } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    expect(store.getSnapshot().get("42")).toEqual({
      data: null,
      loading: true,
      error: null,
      progress: null,
    });

    resolve("42", "payload");
    await flush();

    expect(store.getSnapshot().get("42")).toEqual({
      data: "payload",
      loading: false,
      error: null,
      progress: null,
    });
    expect(calls).toEqual(["42"]);
  });

  it("ignores a repeat request while the first is in flight", () => {
    const { fetcher, calls } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    store.request("42");
    store.request("42");

    expect(calls).toEqual(["42"]);
  });

  it("ignores a repeat request for an already-loaded key", async () => {
    const { fetcher, calls, resolve } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    resolve("42", "payload");
    await flush();
    store.request("42");

    expect(calls).toEqual(["42"]);
  });

  it("records the failure and does not refetch a failed key (#250)", async () => {
    const { fetcher, calls, reject } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    reject("42", "network down");
    await flush();

    expect(store.getSnapshot().get("42")).toEqual({
      data: null,
      loading: false,
      error: "Error: network down",
      progress: null,
    });

    // The unbounded-refetch bug: the failure itself changed the state that
    // re-entered the effect, and "cached or in flight" let the retry through.
    store.request("42");
    store.request("42");
    expect(calls).toEqual(["42"]);
  });

  it("refetches a failed key only on an explicit retry", async () => {
    const { fetcher, calls, reject, resolve } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    reject("42", "network down");
    await flush();

    store.retry("42");
    expect(calls).toEqual(["42", "42"]);
    expect(store.getSnapshot().get("42")?.loading).toBe(true);
    expect(store.getSnapshot().get("42")?.error).toBeNull();

    resolve("42", "payload");
    await flush();
    expect(store.getSnapshot().get("42")?.data).toBe("payload");
  });

  it("ignores a retry while a fetch is already in flight", () => {
    const { fetcher, calls } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    store.retry("42");

    expect(calls).toEqual(["42"]);
  });

  it("keeps keys independent", async () => {
    const { fetcher, reject, resolve } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("1");
    store.request("2");
    resolve("1", "one");
    reject("2", "gone");
    await flush();

    expect(store.getSnapshot().get("1")?.data).toBe("one");
    expect(store.getSnapshot().get("2")?.error).toBe("Error: gone");
  });

  it("records a progress message against its own key only (#55)", () => {
    const { fetcher, progress } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("1");
    store.request("2");
    progress("1", "Listed 200 activities");

    expect(store.getSnapshot().get("1")).toEqual({
      data: null,
      loading: true,
      error: null,
      progress: "Listed 200 activities",
    });
    expect(store.getSnapshot().get("2")?.progress).toBeNull();
  });

  it("drops the progress line when a fetch fails, and a retry starts from none", async () => {
    const { fetcher, progress, reject } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    progress("42", "Listed 200 activities");
    reject("42", "Request timed out");
    await flush();
    expect(store.getSnapshot().get("42")?.progress).toBeNull();

    // The retry has reported nothing yet, so the failed attempt's last line
    // would describe work that is not happening.
    store.retry("42");
    expect(store.getSnapshot().get("42")?.loading).toBe(true);
    expect(store.getSnapshot().get("42")?.progress).toBeNull();
  });

  it("ignores a progress message that lands after the fetch settled", async () => {
    const { fetcher, progress, resolve } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);

    store.request("42");
    resolve("42", "payload");
    await flush();
    const settled = store.getSnapshot();

    progress("42", "Listed 200 activities");

    // A late message must not turn a loaded key back into a loading one.
    expect(store.getSnapshot()).toBe(settled);
    expect(settled.get("42")).toEqual({
      data: "payload",
      loading: false,
      error: null,
      progress: null,
    });
  });

  it("notifies subscribers and hands out a fresh snapshot each change", async () => {
    const { fetcher, resolve } = deferredFetcher();
    const store = new KeyedFetchStore(fetcher);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const initial = store.getSnapshot();
    store.request("42");
    const loadingSnapshot = store.getSnapshot();
    resolve("42", "payload");
    await flush();

    expect(listener).toHaveBeenCalledTimes(2);
    // Identity must change per update, or useSyncExternalStore never re-renders.
    expect(loadingSnapshot).not.toBe(initial);
    expect(store.getSnapshot()).not.toBe(loadingSnapshot);

    unsubscribe();
    store.retry("42");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
