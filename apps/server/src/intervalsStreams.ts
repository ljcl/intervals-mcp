/**
 * intervals.icu stream adapter: turns the raw `getActivityStreams` response
 * (`intervalsClient.ts`) into the named-array shape the analysis modules
 * consume (mirrors `HillStreams`/`AerobicStreams`'s local shapes), and
 * derives `moving`, which intervals.icu never returns: the stream is
 * silently omitted rather than erroring (research note 2026-09-24). Every
 * other stream keeps `null` samples as `null`; callers decide how to treat
 * gaps. A heart-rate dropout arrives as 0, not `null`, so it becomes `null`
 * here, once, for every caller (see {@link heartrateSample}). See AGENTS.md's
 * stream-read invariant.
 */
import {
  getActivityStreams,
  IntervalsApiError,
  type IntervalsStream,
} from "./intervalsClient";

/**
 * Every stream type any caller may ask for, sorted. It is the one list every
 * read requests, so each activity's read is one URL that `FetchClient`
 * caches and coalesces across tools and apps (#71). A new type added here is
 * paid for on every read.
 */
export const INTERVALS_STREAM_TYPES = [
  "altitude",
  "cadence",
  "distance",
  "grade_smooth",
  "heartrate",
  "latlng",
  "stance_time",
  "step_length",
  "time",
  "velocity_smooth",
  "vertical_oscillation",
  "vertical_ratio",
  "watts",
] as const;

/** Stream type names a caller can ask {@link loadIntervalsStreams} for. */
export type IntervalsStreamType = (typeof INTERVALS_STREAM_TYPES)[number];

/** Named, index-aligned streams for one activity. */
export interface IntervalsStreams {
  /** Seconds since activity start. Never `null` (see null-time handling below). */
  time: number[];
  distance?: (number | null)[];
  heartrate?: (number | null)[];
  velocity_smooth?: (number | null)[];
  altitude?: (number | null)[];
  grade_smooth?: (number | null)[];
  cadence?: (number | null)[];
  watts?: (number | null)[];
  /** `[lat, lng]` pairs; intervals.icu stores lat in `data`, lng in `data2`. */
  latlng?: ([number, number] | null)[];
  /** Ground contact time, ms. Running dynamics; Apple Watch and similar. */
  stance_time?: (number | null)[];
  /** Vertical oscillation, mm. */
  vertical_oscillation?: (number | null)[];
  /** Vertical ratio, %. */
  vertical_ratio?: (number | null)[];
  /** Step length, mm. */
  step_length?: (number | null)[];
  /** Derived; never returned by the API (see module comment). */
  moving: boolean[];
  /** Number of samples in `time` (and in every other array present). */
  length: number;
  /** Raw samples dropped for a `null` time. Set by `loadIntervalsStreams`.
   * Above 0, an index from intervals.icu (such as an activity's
   * `ignore_parts`) no longer points at the same sample here. */
  droppedSamples?: number;
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
 * A recording gap longer than this many seconds may be a pause (an
 * auto-pause resume point); the distance across it decides (see
 * {@link deriveMoving}). intervals.icu auto-pause gaps of 38 to 76 s were
 * observed on the athlete's account (research note 2026-09-24); 5 s sits
 * well below every observed gap while staying above the normal 1 s sample
 * cadence, so a real pause is always checked.
 */
export const MOVING_GAP_THRESHOLD_SECONDS = 5;

/**
 * Below this speed (m/s), a sample counts as stopped: its smoothed velocity
 * when known, or the average speed across a gap longer than
 * {@link MOVING_GAP_THRESHOLD_SECONDS}.
 */
export const MOVING_MIN_VELOCITY_MPS = 0.5;

/**
 * Derives `moving` from elapsed-time gaps, distance and (when requested)
 * smoothed velocity. `moving[i]` is `false` when `velocity_smooth[i]` is a
 * known value below {@link MOVING_MIN_VELOCITY_MPS}, or when the gap since
 * the previous sample exceeds {@link MOVING_GAP_THRESHOLD_SECONDS} and is a
 * stop: the distance covered across it implies a speed below
 * {@link MOVING_MIN_VELOCITY_MPS}. A watch auto-pause shows as a time gap
 * with almost no distance; a gap covered at running speed is sparse
 * sampling (Garmin "smart recording"), not a stop, so its time stays moving
 * time (#73). When `distance` is unknown at either end of the gap (no GPS,
 * no distance stream), the gap alone counts as a stop, as before. A `null`
 * velocity sample is unknown, not stopped, and never flags a sample by
 * itself. `moving[0]` has no previous sample to gap against, so it is
 * `true` unless velocity at index 0 is known and below the threshold.
 */
function deriveMoving(
  time: number[],
  distance: (number | null)[] | undefined,
  velocity: (number | null)[] | undefined,
): boolean[] {
  return time.map((current, index) => {
    const v = velocity?.[index];
    const belowThreshold = v != null && v < MOVING_MIN_VELOCITY_MPS;

    if (index === 0) {
      return !belowThreshold;
    }

    const gap = current - (time[index - 1] as number);
    if (gap <= MOVING_GAP_THRESHOLD_SECONDS) {
      return !belowThreshold;
    }

    const from = distance?.[index - 1];
    const to = distance?.[index];
    const stopped =
      from == null || to == null || (to - from) / gap < MOVING_MIN_VELOCITY_MPS;
    return !stopped && !belowThreshold;
  });
}

type OptionalStreamType = Exclude<IntervalsStreamType, "time" | "latlng">;

/**
 * The plain numeric streams, copied index-aligned when requested. `time` and
 * `latlng` have their own handling. The order fixes the result's key order.
 */
export const OPTIONAL_STREAM_TYPES: readonly OptionalStreamType[] = [
  "distance",
  "heartrate",
  "velocity_smooth",
  "altitude",
  "grade_smooth",
  "cadence",
  "watts",
  "stance_time",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
];

/**
 * intervals.icu sends 0, not `null`, for a heart-rate sample where the
 * sensor lost contact (docs/api-notes.md, verified 2026-09-26). No real
 * heart rate is 0 or below, so such a sample becomes `null`: a gap, like any
 * other missing sample. `watts` and `cadence` keep their zeros, because 0 W
 * while coasting and 0 cadence while stopped are real values.
 */
function heartrateSample(value: number | null): number | null {
  return value !== null && value <= 0 ? null : value;
}

/**
 * Fetches and reshapes an activity's data streams via `getActivityStreams`
 * (`intervalsClient.ts`), calling it exactly once. It requests
 * {@link INTERVALS_STREAM_TYPES} whatever the caller asks for, and returns
 * only the arrays the caller asked for. So every tool's and app's read of one
 * activity is the same URL, fetched once and then served from the cache or
 * the in-flight read. The superset includes `time` and `distance`, which
 * `moving` and every downstream index depend on.
 *
 * Samples where `time` is `null` are dropped, along with the matching sample
 * in every other array, so the returned `time` is always non-null numbers;
 * every other stream keeps `null` samples as `null` for callers to decide
 * how to treat. (Dropping rather than throwing on a null time sample: one
 * bad sample should not discard an otherwise-usable activity.) A heart-rate
 * sample of 0 or below is a dropout and comes back `null` too
 * ({@link heartrateSample}).
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
  let raw: IntervalsStream[];
  try {
    raw = await getActivityStreams(apiKey, id, [...INTERVALS_STREAM_TYPES]);
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

  const result: IntervalsStreams = {
    time,
    moving: [],
    length: time.length,
    droppedSamples: timeStream.data.length - time.length,
  };
  const aligned = (stream: IntervalsStream) =>
    keepIndices.map((index) => stream.data[index] ?? null);

  for (const type of OPTIONAL_STREAM_TYPES) {
    if (!types.includes(type)) continue;
    const stream = byType.get(type);
    if (!stream) continue;
    const values = aligned(stream);
    result[type] = type === "heartrate" ? values.map(heartrateSample) : values;
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

  // `distance` is always requested for `moving`, but returned only when the
  // caller asked for it. `velocity_smooth` counts toward `moving` only when
  // the caller asked for it, as before the superset read.
  const distanceStream = byType.get("distance");
  const distance =
    result.distance ?? (distanceStream ? aligned(distanceStream) : undefined);
  result.moving = deriveMoving(time, distance, result.velocity_smooth);

  return result;
}
