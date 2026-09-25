/**
 * A bounded in-memory cache with per-entry TTL and least-recently-used (LRU)
 * eviction.
 *
 * Many intervals.icu resources are effectively immutable once recorded (a
 * completed activity's detail and its data streams never change), and each
 * MCP App fires its `view-` and `get-…-data` tools together on open, doubling
 * the cost of an uncached read. Re-fetching an immutable-ish resource on
 * every tool call burns quota for no benefit: `get-best-efforts` alone
 * fetches full activity detail once per activity (up to 100). This cache lets
 * the HTTP layer (see {@link FetchClient}) serve repeat reads of
 * immutable-ish resources without another round-trip, while bounding memory
 * growth and expiring entries so stale data does not linger forever.
 *
 * Ordering: JS `Map` preserves insertion order, so the first key is the
 * least-recently-used. Reads and writes re-insert the touched key to move it to
 * the most-recently-used end; eviction always drops from the front.
 */
export interface CacheEntry<V> {
  value: V;
  /** Absolute expiry time in ms (compared against {@link TtlLruCache.now}). */
  expiresAt: number;
}

export interface TtlLruCacheOptions {
  /** Maximum live entries before LRU eviction kicks in (default 200). */
  maxEntries?: number;
  /** Injectable clock (ms). Defaults to {@link Date.now}; tests override it. */
  now?: () => number;
}

export class TtlLruCache<V = unknown> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns the cached value for `key` if present and unexpired, otherwise
   * `undefined`. Expired entries are evicted on access. A hit moves the key to
   * the most-recently-used position.
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency: delete + re-insert moves the key to the MRU end.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * Stores `value` under `key` with a relative `ttlMs` lifetime, then evicts the
   * least-recently-used entries while the cache is over capacity. A non-positive
   * `ttlMs` is a no-op (the entry would already be expired).
   */
  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) {
      this.store.delete(key);
      return;
    }
    // Re-insert so an updated key counts as most-recently-used.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });

    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Removes a single entry. Returns true if it existed. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Removes every entry whose key satisfies `predicate`. Used to invalidate all
   * cached resources under a written path. Returns the number removed.
   *
   * Deleting during `Map` key iteration is safe: keys already visited or the
   * current one can be removed without disturbing the remaining traversal.
   */
  deleteMatching(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of this.store.keys()) {
      if (predicate(key)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Empties the cache. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries currently held (including any not-yet-evicted expired). */
  get size(): number {
    return this.store.size;
  }
}
