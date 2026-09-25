/**
 * Bounded-concurrency scheduling for tools that resolve several ids with one
 * request each.
 *
 * `get-best-efforts` resolves each winning activity's name/race flag with
 * its own `getActivity` call (up to 30, distances x topN); a serial loop
 * over that many ids spends that many sequential round-trips, while an
 * unbounded `Promise.all` fires them all at once with no pacing at all,
 * ahead of what the fetch layer's own throttle and backoff can smooth out.
 *
 * Not tied to any one tool, so it lives here. Do not copy it into a tool: a
 * fix then lands in one copy and leaves the other wrong, and neither knip
 * nor Biome can see a genuinely-imported duplicate.
 *
 * The helper stays a pure scheduling primitive: it knows nothing about the
 * upstream API. Failure policy (what counts as fatal, what to report)
 * belongs to the calling tool, via its own `catch` around `worker` and,
 * where it wants an early exit, the optional `shouldStop`.
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
