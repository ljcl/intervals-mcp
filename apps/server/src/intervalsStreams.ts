/**
 * intervals.icu stream adapter: turns the raw `getActivityStreams` response
 * (`intervalsClient.ts`) into the named-array shape the analysis modules
 * consume (mirrors `HillStreams`/`AerobicStreams`'s local shapes), and
 * derives `moving`, which intervals.icu never returns: the stream is
 * silently omitted rather than erroring (research note 2026-09-24). Every
 * other stream keeps `null` samples as `null`; callers decide how to treat
 * gaps.
 *
 * Counterpart to the Strava client's `getActivityStreams`/
 * `StreamsUnavailableError` pair (see AGENTS.md's stream-read invariant).
 */
import {
  getActivityStreams,
  IntervalsApiError,
  type IntervalsStream,
} from "./intervalsClient";

/** Stream type names used by the Phase 2 analysis modules. */
export type IntervalsStreamType =
  | "time"
  | "distance"
  | "heartrate"
  | "velocity_smooth"
  | "altitude"
  | "fixed_altitude"
  | "grade_smooth"
  | "cadence"
  | "watts"
  | "latlng";

/** Named, index-aligned streams for one activity. */
export interface IntervalsStreams {
  /** Seconds since activity start. Never `null` (see null-time handling below). */
  time: number[];
  distance?: (number | null)[];
  heartrate?: (number | null)[];
  velocity_smooth?: (number | null)[];
  altitude?: (number | null)[];
  fixed_altitude?: (number | null)[];
  grade_smooth?: (number | null)[];
  cadence?: (number | null)[];
  watts?: (number | null)[];
  /** `[lat, lng]` pairs; intervals.icu stores lat in `data`, lng in `data2`. */
  latlng?: ([number, number] | null)[];
  /** Derived; never returned by the API (see module comment). */
  moving: boolean[];
  /** Number of samples in `time` (and in every other array present). */
  length: number;
}

/** What `loadIntervalsStreams` can be called for. Only activities today. */
export type IntervalsStreamResourceKind = "activity";

/**
 * The activity genuinely has no recorded samples: intervals.icu answered
 * 404, returned an empty stream set, or returned a set with no `time`
 * stream. Distinct from every other failure so a caller can degrade (report
 * "no data" for a manual/no-GPS entry) without also swallowing an expired
 * key or an exhausted rate limit.
 */
export class IntervalsStreamsUnavailableError extends Error {
  activityId: string;
  kind: IntervalsStreamResourceKind;

  constructor(
    activityId: string,
    kind: IntervalsStreamResourceKind = "activity",
  ) {
    super(`No data streams are recorded for ${kind} ${activityId}.`);
    this.name = "IntervalsStreamsUnavailableError";
    this.activityId = activityId;
    this.kind = kind;
  }
}

/**
 * A recording gap longer than this many seconds marks the sample after the
 * gap as not moving (an auto-pause resume point). intervals.icu auto-pause
 * gaps of 38 to 76 s were observed on the athlete's account (research note
 * 2026-09-24); 5 s sits well below every observed gap while staying above
 * the normal 1 s sample cadence, so a real pause is always caught.
 */
export const MOVING_GAP_THRESHOLD_SECONDS = 5;

/** Below this speed (m/s), a sample counts as stopped when velocity is known. */
export const MOVING_MIN_VELOCITY_MPS = 0.5;

/**
 * Derives `moving` from elapsed-time gaps and (when requested) smoothed
 * velocity. `moving[i]` is `false` when the gap since the previous sample
 * exceeds {@link MOVING_GAP_THRESHOLD_SECONDS}, or `velocity_smooth[i]` is a
 * known value below {@link MOVING_MIN_VELOCITY_MPS}; `true` otherwise. A
 * `null` velocity sample is unknown, not stopped, and never flags a sample
 * by itself. `moving[0]` has no previous sample to gap against, so it is
 * `true` unless velocity at index 0 is known and below the threshold.
 */
function deriveMoving(
  time: number[],
  velocity: (number | null)[] | undefined,
): boolean[] {
  return time.map((current, index) => {
    const v = velocity?.[index];
    const belowThreshold = v != null && v < MOVING_MIN_VELOCITY_MPS;

    if (index === 0) {
      return !belowThreshold;
    }

    const previous = time[index - 1] as number;
    const gapped = current - previous > MOVING_GAP_THRESHOLD_SECONDS;
    return !gapped && !belowThreshold;
  });
}

type OptionalStreamType = Exclude<IntervalsStreamType, "time" | "latlng">;

const OPTIONAL_STREAM_TYPES: OptionalStreamType[] = [
  "distance",
  "heartrate",
  "velocity_smooth",
  "altitude",
  "fixed_altitude",
  "grade_smooth",
  "cadence",
  "watts",
];

/**
 * Fetches and reshapes an activity's data streams via `getActivityStreams`
 * (`intervalsClient.ts`), calling it exactly once. Requests `time` even when
 * the caller omits it, since `moving` and every downstream index depend on
 * it, but only returns the optional arrays the caller actually asked for.
 *
 * Samples where `time` is `null` are dropped, along with the matching sample
 * in every other array, so the returned `time` is always non-null numbers;
 * every other stream keeps `null` samples as `null` for callers to decide
 * how to treat. (Dropping rather than throwing on a null time sample: one
 * bad sample should not discard an otherwise-usable activity.)
 *
 * @throws {IntervalsStreamsUnavailableError} on a genuine 404, an empty
 * response, a response with no `time` stream, or a `time` stream that is
 * entirely `null`. Any other error (rate limit, auth, 5xx) propagates
 * unchanged.
 */
export async function loadIntervalsStreams(
  apiKey: string,
  id: string,
  types: IntervalsStreamType[],
): Promise<IntervalsStreams> {
  const requestTypes = types.includes("time") ? types : ["time", ...types];

  let raw: IntervalsStream[];
  try {
    raw = await getActivityStreams(apiKey, id, requestTypes);
  } catch (error) {
    if (error instanceof IntervalsApiError && error.response.status === 404) {
      throw new IntervalsStreamsUnavailableError(id);
    }
    throw error;
  }

  if (raw.length === 0) {
    throw new IntervalsStreamsUnavailableError(id);
  }

  const byType = new Map(raw.map((stream) => [stream.type, stream]));
  const timeStream = byType.get("time");
  if (!timeStream) {
    throw new IntervalsStreamsUnavailableError(id);
  }

  const keepIndices: number[] = [];
  const time: number[] = [];
  timeStream.data.forEach((sample, index) => {
    if (sample !== null) {
      keepIndices.push(index);
      time.push(sample);
    }
  });

  if (time.length === 0) {
    throw new IntervalsStreamsUnavailableError(id);
  }

  const result: IntervalsStreams = { time, moving: [], length: time.length };

  for (const type of OPTIONAL_STREAM_TYPES) {
    if (!types.includes(type)) continue;
    const stream = byType.get(type);
    if (!stream) continue;
    result[type] = keepIndices.map((index) => stream.data[index] ?? null);
  }

  if (types.includes("latlng")) {
    const stream = byType.get("latlng");
    if (stream) {
      const lat = stream.data;
      const lng = stream.data2 ?? [];
      result.latlng = keepIndices.map((index) => {
        const la = lat[index];
        const lo = lng[index];
        return la != null && lo != null ? ([la, lo] as [number, number]) : null;
      });
    }
  }

  result.moving = deriveMoving(time, result.velocity_smooth);

  return result;
}
