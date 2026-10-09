/**
 * A bounded in-memory cache with per-entry TTL and least-recently-used (LRU)
 * eviction.
 *
 * Many intervals.icu resources are effectively immutable once recorded (a
 * completed activity's detail and its data streams never change), and each
 * MCP App fires its `view-` and `get-…-data` tools together on open, doubling
 * the cost of an uncached read. Re-fetching an immutable-ish resource on
 * every tool call burns quota for no benefit. This cache lets the HTTP
 * layer (see {@link FetchClient}) serve repeat reads of immutable-ish
 * resources without another round-trip, while bounding memory growth and
 * expiring entries so stale data does not linger forever.
 *
 * Bounds: the cache holds at most `maxEntries` entries and at most `maxBytes`
 * of summed entry size. A write evicts from the LRU end until both hold. Every
 * write also sweeps out expired entries first, so an entry that nobody reads
 * again does not hold memory until LRU eviction reaches it.
 *
 * Clock: the default is `Date.now`, the wall clock. A host suspend then
 * expires entries, as it should for data that may have changed meanwhile.
 *
 * Ordering: JS `Map` preserves insertion order, so the first key is the
 * least-recently-used. Reads and writes re-insert the touched key to move it to
 * the most-recently-used end; eviction always drops from the front.
 */
export interface CacheEntry<V> {
  value: V;
  /** Absolute expiry time in ms (compared against {@link TtlLruCache.now}). */
  expiresAt: number;
  /** The size `set` stored the entry with, counted against `maxBytes`. */
  size: number;
}

export interface TtlLruCacheOptions {
  /** Maximum live entries before LRU eviction kicks in (default 200). */
  maxEntries?: number;
  /**
   * A rough budget on the summed entry sizes, in the unit of `set`'s `size`
   * argument (default `Infinity`). An entry bigger than the whole budget is
   * not stored.
   */
  maxBytes?: number;
  /** Injectable clock (ms). Defaults to {@link Date.now}; tests override it. */
  now?: () => number;
}

export class TtlLruCache<V = unknown> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  /** Summed `size` of every entry in {@link store}. */
  private totalBytes = 0;

  constructor(options: TtlLruCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
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
      this.remove(key);
      return undefined;
    }
    // Refresh recency: delete + re-insert moves the key to the MRU end. This
    // puts the same entry back, so it is not a removal: it does not go through
    // remove() and leaves totalBytes unchanged.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * Stores `value` under `key` with a relative `ttlMs` lifetime and a `size`
   * counted against `maxBytes`, then evicts the least-recently-used entries
   * until the cache is within both bounds. A non-positive `ttlMs` (the entry
   * would already be expired) or a `size` above `maxBytes` (it could never
   * fit) only removes any existing entry for `key`.
   */
  set(key: string, value: V, ttlMs: number, size = 0): void {
    if (ttlMs <= 0 || size > this.maxBytes) {
      this.remove(key);
      return;
    }
    this.sweepExpired();
    // Re-insert so an updated key counts as most-recently-used.
    this.remove(key);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs, size });
    this.totalBytes += size;

    while (
      this.store.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  /** Removes a single entry. Returns true if it existed. */
  delete(key: string): boolean {
    return this.remove(key);
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
        this.remove(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Empties the cache. */
  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  /** Number of entries currently held (including any not-yet-evicted expired). */
  get size(): number {
    return this.store.size;
  }

  /** Summed size of the entries currently held, in `set`'s `size` unit. */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Drops `key` and takes its size off {@link totalBytes}. Every removal goes
   * through here, so the byte count stays exact. Returns true if it existed.
   */
  private remove(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) return false;
    this.totalBytes -= entry.size;
    this.store.delete(key);
    return true;
  }

  /** Removes every expired entry, read or not. */
  private sweepExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }
}
