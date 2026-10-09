import { describe, expect, it } from "vitest";
import { TtlLruCache } from "./cache";

/**
 * A controllable clock so TTL expiry is deterministic — no real timers, no
 * flakiness.
 */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("TtlLruCache", () => {
  it("returns a stored value within its TTL (hit)", () => {
    const cache = new TtlLruCache<string>();
    cache.set("a", "value-a", 1000);
    expect(cache.get("a")).toBe("value-a");
  });

  it("returns undefined for an unknown key (miss)", () => {
    const cache = new TtlLruCache<string>();
    expect(cache.get("nope")).toBeUndefined();
  });

  it("expires entries once the TTL elapses and evicts them on access", () => {
    const clock = fakeClock();
    const cache = new TtlLruCache<string>({ now: clock.now });

    cache.set("a", "value-a", 1000);
    clock.advance(999);
    expect(cache.get("a")).toBe("value-a");

    clock.advance(1); // now exactly at expiry boundary
    expect(cache.get("a")).toBeUndefined();
    // The expired entry was dropped, not just hidden.
    expect(cache.size).toBe(0);
  });

  it("treats a non-positive TTL as a delete", () => {
    const cache = new TtlLruCache<string>();
    cache.set("a", "value-a", 1000);
    cache.set("a", "value-a", 0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least-recently-used entry when over capacity", () => {
    const cache = new TtlLruCache<string>({ maxEntries: 2 });
    cache.set("a", "A", 1000);
    cache.set("b", "B", 1000);
    // Touch "a" so "b" becomes the LRU entry.
    expect(cache.get("a")).toBe("A");

    cache.set("c", "C", 1000); // exceeds capacity, evicts LRU ("b")

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.size).toBe(2);
  });

  it("re-inserting an existing key refreshes its recency, not the size", () => {
    const cache = new TtlLruCache<string>({ maxEntries: 2 });
    cache.set("a", "A", 1000);
    cache.set("b", "B", 1000);
    cache.set("a", "A2", 1000); // update "a" -> now MRU
    cache.set("c", "C", 1000); // evicts LRU ("b")

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A2");
    expect(cache.get("c")).toBe("C");
  });

  it("deletes a single key", () => {
    const cache = new TtlLruCache<string>();
    cache.set("a", "A", 1000);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
  });

  it("invalidates every key matching a predicate", () => {
    const cache = new TtlLruCache<string>();
    cache.set("/activities/1", "detail", 1000);
    cache.set("/activities/1/streams/x", "streams", 1000);
    cache.set("/activities/2", "other", 1000);

    const removed = cache.deleteMatching((key) =>
      key.startsWith("/activities/1"),
    );

    expect(removed).toBe(2);
    expect(cache.get("/activities/1")).toBeUndefined();
    expect(cache.get("/activities/1/streams/x")).toBeUndefined();
    expect(cache.get("/activities/2")).toBe("other");
  });

  it("clear() empties the cache", () => {
    const cache = new TtlLruCache<string>();
    cache.set("a", "A", 1000);
    cache.set("b", "B", 1000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("TtlLruCache byte budget (#71)", () => {
  it("evicts the least-recently-used entry when the byte budget is exceeded", () => {
    const cache = new TtlLruCache<string>({ maxBytes: 100 });
    cache.set("a", "A", 1000, 40);
    cache.set("b", "B", 1000, 40);
    cache.set("c", "C", 1000, 40);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.bytes).toBe(80);
    expect(cache.size).toBe(2);
  });

  it("does not store an entry bigger than the whole budget, and drops the old one", () => {
    const cache = new TtlLruCache<string>({ maxBytes: 100 });
    cache.set("a", "small", 1000, 10);
    cache.set("a", "huge", 1000, 150);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it("does not evict other entries for an entry bigger than the whole budget", () => {
    const cache = new TtlLruCache<string>({ maxBytes: 100 });
    cache.set("b", "B", 1000, 40);
    cache.set("a", "huge", 1000, 150);

    // Stored, it would sit at the MRU end, and eviction would empty the cache.
    expect(cache.get("b")).toBe("B");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.bytes).toBe(40);
    expect(cache.size).toBe(1);
  });

  it("counts only the new size when a key is overwritten", () => {
    const cache = new TtlLruCache<string>({ maxBytes: 100 });
    cache.set("a", "A", 1000, 40);
    cache.set("a", "A2", 1000, 10);

    expect(cache.bytes).toBe(10);
    expect(cache.size).toBe(1);
  });

  it("sweeps expired entries on every write, read or not", () => {
    const clock = fakeClock();
    const cache = new TtlLruCache<string>({ now: clock.now });
    cache.set("a", "A", 100, 10);
    cache.set("b", "B", 1000, 20);
    clock.advance(200);
    cache.set("c", "C", 1000, 30);

    // "a" expired and was never read, but the write removed it.
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(50);
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("keeps the byte count exact through delete, deleteMatching, clear and expiry", () => {
    const clock = fakeClock();
    const cache = new TtlLruCache<string>({ now: clock.now });
    cache.set("/a/1", "x", 1000, 10);
    cache.set("/a/2", "x", 1000, 20);
    cache.set("/b/1", "x", 100, 30);
    cache.set("/b/2", "x", 1000, 40);
    expect(cache.bytes).toBe(100);

    expect(cache.delete("/b/2")).toBe(true);
    expect(cache.bytes).toBe(60);
    expect(cache.delete("/b/2")).toBe(false);
    expect(cache.bytes).toBe(60);

    expect(cache.deleteMatching((key) => key.startsWith("/a/"))).toBe(2);
    expect(cache.bytes).toBe(30);

    clock.advance(100);
    expect(cache.get("/b/1")).toBeUndefined();
    expect(cache.bytes).toBe(0);

    cache.set("/c", "x", 1000, 50);
    cache.clear();
    expect(cache.bytes).toBe(0);
    cache.set("/c", "x", 1000, 5);
    expect(cache.bytes).toBe(5);
  });

  it("does not change the byte count on a hit, and a hit protects the entry from eviction", () => {
    const cache = new TtlLruCache<string>({ maxBytes: 100 });
    cache.set("a", "A", 1000, 40);
    cache.set("b", "B", 1000, 40);
    for (let i = 0; i < 3; i += 1) expect(cache.get("a")).toBe("A");
    expect(cache.bytes).toBe(80);

    // "b" is now the least recently used, so it goes first.
    cache.set("c", "C", 1000, 40);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.bytes).toBe(80);
  });

  it("stays under its byte budget with large payloads", () => {
    const cache = new TtlLruCache<number>({ maxBytes: 1_000_000 });
    for (let i = 0; i < 100; i += 1) {
      cache.set(`stream-${i}`, i, 60_000, 100_000);
      expect(cache.bytes).toBeLessThanOrEqual(1_000_000);
    }
    expect(cache.size).toBe(10);
    expect(cache.bytes).toBe(1_000_000);
  });
});
