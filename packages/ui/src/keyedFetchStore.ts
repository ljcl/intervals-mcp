/** Per-key fetch state, mirroring `ServerToolData` for a single key. */
export interface KeyedFetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * Latest progress message for this key's fetch, or null when none has
   * arrived. Only ever set while `loading`.
   */
  progress: string | null;
}

/**
 * Loads one key's payload, rejecting on any failure. `onProgress` records a
 * progress message against that key.
 */
export type KeyedFetch<T> = (
  key: string,
  onProgress: (message: string) => void,
) => Promise<T>;

/**
 * The keyed fetch state machine behind `useServerToolFetcher`, deliberately
 * outside React so its two load-bearing rules are directly testable:
 *
 * 1. `request` starts a fetch at most once per key. A key that already
 *    failed stays failed — cadence-trends' hand-rolled version guarded only
 *    on "cached or in flight", so a failed run re-entered the effect on the
 *    very state change its own failure produced and refetched forever.
 * 2. `retry` is the only way back, so the retry control the user sees is the
 *    only thing that re-fires a failed key.
 *
 * An external store rather than `useState` so React subscribes via
 * `useSyncExternalStore` and the snapshot identity is stable between updates.
 */
export class KeyedFetchStore<T> {
  private readonly entries = new Map<string, KeyedFetchState<T>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, KeyedFetchState<T>> = new Map();

  constructor(private readonly fetcher: KeyedFetch<T>) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyMap<string, KeyedFetchState<T>> => this.snapshot;

  /** Fetch `key` unless it is already loaded, in flight, or failed. */
  request = (key: string): void => {
    if (this.entries.has(key)) return;
    void this.run(key);
  };

  /** Fetch `key` again after a failure; a no-op while one is in flight. */
  retry = (key: string): void => {
    if (this.entries.get(key)?.loading) return;
    void this.run(key);
  };

  private async run(key: string): Promise<void> {
    // A retry starts from no progress rather than the stale message of the
    // attempt that failed.
    this.set(key, { data: null, loading: true, error: null, progress: null });
    try {
      const data = await this.fetcher(key, (progress) => {
        const entry = this.entries.get(key);
        // A late message must not touch a key that has already settled.
        if (entry?.loading) this.set(key, { ...entry, progress });
      });
      this.set(key, { data, loading: false, error: null, progress: null });
    } catch (err) {
      this.set(key, {
        data: null,
        loading: false,
        error: String(err),
        progress: null,
      });
    }
  }

  private set(key: string, state: KeyedFetchState<T>): void {
    this.entries.set(key, state);
    // Copy on write: `useSyncExternalStore` compares snapshots by identity,
    // and a mutated-in-place Map would never look changed.
    this.snapshot = new Map(this.entries);
    for (const listener of this.listeners) listener();
  }
}
