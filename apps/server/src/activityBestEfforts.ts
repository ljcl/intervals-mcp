/**
 * Best-effort stretches inside one activity, for `get-best-efforts` with an
 * `id`. Pure functions over the stream adapter's named arrays
 * (`intervalsStreams.ts`).
 *
 * The rule is intervals.icu's own pace-curve rule: for each start sample,
 * take the first sample whose distance reaches the target, and scale the
 * elapsed time across the two to exactly the target distance. It gave every
 * value of three runs' activity pace curves (313 of 313 points,
 * docs/api-notes.md), so a time here equals the same run's point on the
 * athlete pace curve that `get-best-efforts` reads over a window. The time
 * is elapsed time: the `time` stream keeps auto-pause gaps, so a stop inside
 * a stretch counts. `stoppedSeconds` says how much of it was a stop, read
 * from the adapter's `moving` stream. The caller loads `velocity_smooth` so
 * that `moving` also marks a stand at 1 Hz, as the split analysis does: a
 * stop has one definition.
 *
 * Nothing here rounds; the tool rounds for display.
 */

import { z } from "zod";

/** The streams the search needs, as `loadIntervalsStreams` returns them. */
export interface EffortStreams {
  /** Seconds since the activity start. */
  time: number[];
  /** Metres since the activity start; `null` where the sample has none. */
  distance: (number | null)[];
  /** From `loadIntervalsStreams`: `false` at a recording gap that is a stop. */
  moving: boolean[];
}

/** One stretch of exactly the target distance. */
export interface EffortWindow {
  /** First sample of the stretch (index into the loaded streams). */
  startIndex: number;
  /** First sample where the distance from `startIndex` reaches the target. */
  endIndex: number;
  /** Elapsed seconds across the stretch, scaled to exactly the target. */
  seconds: number;
  /** Metres from the first known distance sample to `startIndex`. */
  startM: number;
  /** Metres from the first known distance sample to `endIndex`. */
  endM: number;
  /** Seconds of `time[k] - time[k - 1]`, for k in (startIndex, endIndex],
   * where `moving[k]` is `false`. */
  stoppedSeconds: number;
}

/** The first known distance sample, or `null` when there is none. */
function firstKnown(distance: (number | null)[]): number | null {
  for (const d of distance) if (d != null) return d;
  return null;
}

/** Last known distance minus first known distance, metres; 0 when none. */
export function coveredDistanceM(distance: (number | null)[]): number {
  const first = firstKnown(distance);
  if (first === null) return 0;
  for (let k = distance.length - 1; k >= 0; k -= 1) {
    const d = distance[k];
    if (d != null) return d - first;
  }
  return 0;
}

/**
 * The `count` fastest stretches of `targetM` metres that do not overlap,
 * fastest first (equal seconds: the earlier start first). Two stretches may
 * share an end sample. A stretch with any sample in [startIndex, endIndex]
 * marked in `excluded` is never picked. Fewer than `count` come back when
 * fewer fit, and none when the activity covers less than `targetM`.
 *
 * Two pointers find each start's end sample in one pass, so the search is
 * O(n log n) per distance (the sort).
 */
export function bestEffortWindows(
  streams: EffortStreams,
  targetM: number,
  count: number,
  excluded?: boolean[],
): EffortWindow[] {
  const { time, distance, moving } = streams;
  const n = Math.min(time.length, distance.length);
  const origin = firstKnown(distance);
  if (origin === null || count <= 0 || targetM <= 0) return [];

  // excludedBefore[k] = excluded samples in [0, k).
  let excludedBefore: number[] | null = null;
  if (excluded) {
    excludedBefore = [0];
    for (let k = 0; k < n; k += 1) {
      excludedBefore.push(excludedBefore[k]! + (excluded[k] ? 1 : 0));
    }
  }

  const candidates: { i: number; j: number; seconds: number }[] = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const from = distance[i];
    if (from == null) continue;
    if (j <= i) j = i + 1;
    while (j < n) {
      const to = distance[j];
      if (to != null && to - from >= targetM) break;
      j += 1;
    }
    // The distance only grows, so no later start reaches the target either.
    if (j >= n) break;
    if (excludedBefore && excludedBefore[j + 1]! - excludedBefore[i]! > 0) {
      continue;
    }
    const span = (distance[j] as number) - from;
    candidates.push({
      i,
      j,
      seconds: ((time[j]! - time[i]!) * targetM) / span,
    });
  }

  candidates.sort((a, b) => a.seconds - b.seconds || a.i - b.i);

  const picked: EffortWindow[] = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    const overlaps = picked.some(
      (p) => !(c.j <= p.startIndex || p.endIndex <= c.i),
    );
    if (overlaps) continue;
    let stoppedSeconds = 0;
    for (let k = c.i + 1; k <= c.j; k += 1) {
      if (moving[k] === false) stoppedSeconds += time[k]! - time[k - 1]!;
    }
    picked.push({
      startIndex: c.i,
      endIndex: c.j,
      seconds: c.seconds,
      startM: (distance[c.i] as number) - origin,
      endM: (distance[c.j] as number) - origin,
      stoppedSeconds,
    });
  }
  return picked;
}

/** One `ignore_parts` entry, per the spec's `Ignore` schema. Read leniently:
 * the activity schema passes the field through untyped. */
const IgnorePartsSchema = z.array(
  z
    .object({
      start_index: z.number().int().nullable().optional(),
      end_index: z.number().int().nullable().optional(),
      pace: z.boolean().nullable().optional(),
    })
    .passthrough(),
);

/**
 * The samples inside the activity's `ignore_parts` entries with
 * `pace: true` (parts the athlete marked in intervals.icu to ignore for
 * pace), both ends inclusive, clamped to `length`. Anything that does not
 * parse counts as no ignored parts. `null` when no part applies.
 *
 * The indices point into the raw streams, so the caller applies the mask
 * only when the loader dropped no sample.
 */
export function paceIgnoredMask(
  ignoreParts: unknown,
  length: number,
): { mask: boolean[]; parts: number } | null {
  const parsed = IgnorePartsSchema.safeParse(ignoreParts);
  if (!parsed.success || length <= 0) return null;

  const mask = new Array<boolean>(length).fill(false);
  let parts = 0;
  for (const part of parsed.data) {
    if (part.pace !== true) continue;
    if (part.start_index == null || part.end_index == null) continue;
    const start = Math.max(0, part.start_index);
    const end = Math.min(length - 1, part.end_index);
    if (start > end) continue;
    for (let k = start; k <= end; k += 1) mask[k] = true;
    parts += 1;
  }
  return parts > 0 ? { mask, parts } : null;
}
