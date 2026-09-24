/**
 * Bounded-concurrency scheduling for the scan-style tools.
 *
 * A scan tool makes one Strava request per activity, so a serial loop over
 * the default 100 activities spends 100 sequential round-trips, while an
 * unbounded `Promise.all` spikes the 15-minute quota faster than the fetch
 * layer's backoff can react.
 *
 * `get-best-efforts` and `get-race-prediction` both want exactly this shape,
 * so it lives here rather than inside either one. Do not copy it into a
 * tool: a fix then lands in one copy and leaves the other wrong, and neither
 * knip nor Biome can see a genuinely-imported duplicate.
 *
 * The helper stays a pure scheduling primitive — it knows nothing about
 * Strava. Rate-limit policy (what counts as fatal, what to report) belongs to
 * the calling tool, which injects it via `shouldStop`.
 */

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, stopping
 * early once `shouldStop` reports true.
 *
 * Returns the results of the items that actually completed, **in input
 * order** — an early stop leaves a shorter array, not a reordered or sparse
 * one, so a caller can compare `results.length` against `items.length` to
 * report how many it missed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<R[]> {
  // Boxed so an unstarted slot stays distinguishable from a worker that
  // legitimately resolved to `undefined`.
  const slots = new Array<{ value: R } | undefined>(items.length);
  let next = 0;

  const runners = Array.from(
    { length: Math.max(0, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        if (shouldStop()) return;
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        slots[index] = { value: await worker(item) };
      }
    },
  );

  await Promise.all(runners);

  const results: R[] = [];
  for (const slot of slots) {
    if (slot !== undefined) results.push(slot.value);
  }
  return results;
}
