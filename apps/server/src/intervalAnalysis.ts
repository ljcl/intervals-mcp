import { interpolateNulls } from "./hillAnalysis";

/**
 * Urban-stop-aware interval detection for `get-interval-analysis`.
 * Pure functions over the intervals.icu stream adapter's named arrays
 * (`intervalsStreams.ts`) and intervals.icu-derived laps, unit-tested next
 * to `trainingLoad.ts`.
 *
 * Rest-segment-based interval detection false-positives on urban runs:
 * traffic-light stops read as recovery intervals. The corrective heuristic
 * lives here: a short rest with no fast work before it is a traffic light,
 * a rest with a matching fast preceding effort is genuine interval
 * recovery, and a single long outlier is a café/regroup stop. Work reps are
 * reconstructed between recoveries (merging straight through traffic
 * lights), and pace/HR/cadence fade across reps is reported. Clean
 * structured laps are preferred over stream reconstruction when present,
 * because device laps corrupt in rain/sweat but are exact when healthy.
 */

/**
 * Streams as returned by `loadIntervalsStreams`, index-aligned. `distance`
 * is interpolated across nulls internally (see `computeIntervalAnalysis`,
 * mirroring `hillAnalysis.ts`'s `normalizeHillStreams`); every other stream
 * keeps a null sample as "no data for this sample" and is simply excluded
 * from whatever average it would have fed.
 */
export interface IntervalStreams {
  /** Seconds since activity start, non-decreasing. */
  time: number[];
  /** Cumulative metres. Required. */
  distance: (number | null)[];
  /** Derived stopped/moving flag; false = stopped. Needed for rest detection. */
  moving?: boolean[];
  heartrate?: (number | null)[];
  /** Smoothed speed in m/s. */
  velocity_smooth?: (number | null)[];
  watts?: (number | null)[];
  /** Run cadence in strides-per-minute (one leg, as intervals.icu records it). */
  cadence?: (number | null)[];
}

/** Minimal slice of an intervals.icu lap the analysis needs. */
export interface IntervalLap {
  lapIndex: number;
  distanceM: number;
  movingTimeS: number;
  avgSpeedMs: number | null;
  avgHr: number | null;
  avgCadence: number | null;
  avgWatts: number | null;
}

/** Raised for inputs the analysis cannot work with; message is user-facing. */
export class IntervalAnalysisError extends Error {}

// Tunable classification thresholds.
/** Rests shorter than this with no fast preceding effort are traffic lights. */
export const REST_URBAN_MAX_SECONDS = 60;
/** Upper bound for a rest to count as genuine interval recovery. */
export const REST_RECOVERY_MAX_SECONDS = 180;
/** Rests longer than this are café/regroup/kit stops. */
export const REST_LONG_STOP_MIN_SECONDS = 300;
/** Stopped spans shorter than this are GPS blips, not rests. */
export const MIN_REST_SECONDS = 10;
/** A work segment is "fast" at this multiple of the overall moving speed. */
export const FAST_SEGMENT_FACTOR = 1.08;
/** Sample gaps longer than this contribute only this much weight. */
export const MAX_SAMPLE_GAP_SECONDS = 10;
/** Max speed spread (coefficient of variation) for laps to count as clean. */
export const CLEAN_LAP_SPEED_COV = 0.08;
/** Share of moving time near max HR that reads as a hard workout. */
export const HR_HIGH_INTENSITY_SHARE = 0.15;
/**
 * Minimum fraction of a rep's moving time that must carry a real (non-zero)
 * power sample before an average is reported; below this the power stream is
 * too gappy to summarise and the field is omitted.
 */
export const POWER_COVERAGE_MIN = 0.7;

export type RestKind =
  | "traffic_light"
  | "recovery"
  | "long_stop"
  | "other_stop";

export interface RestSegment {
  /** Seconds since activity start when the stop began. */
  startTimeS: number;
  durationS: number;
  /** Kilometre mark of the stop. */
  atKm: number;
  kind: RestKind;
  reason: string;
}

export interface WorkRep {
  index: number;
  startKm: number;
  distanceM: number;
  movingTimeS: number;
  paceSecPerKm: number | null;
  avgHr: number | null;
  /** Raw stream/lap cadence (one-leg spm for runs). */
  avgCadence: number | null;
  avgWatts: number | null;
}

export interface IntervalFade {
  /** % pace change last rep vs first; positive = slower. */
  paceDriftPct: number | null;
  /** HR change last rep vs first, in bpm. */
  hrDriftBpm: number | null;
  /** % cadence change last rep vs first. */
  cadenceDriftPct: number | null;
  summary: string;
}

export interface HrSignal {
  maxHr: number;
  /** Share (0–1) of time spent at ≥ 88% of the activity's max HR. */
  highIntensityShare: number;
  assessment: string;
}

export interface IntervalAnalysis {
  isIntervals: boolean;
  /** Where the reps came from: clean device laps or stream reconstruction. */
  source: "laps" | "streams" | "none";
  reps: WorkRep[];
  rests: RestSegment[];
  fade: IntervalFade | null;
  hrSignal: HrSignal | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  warnings: string[];
}

const round = (value: number, dp = 2) =>
  Math.round(value * 10 ** dp) / 10 ** dp;

interface Aggregates {
  startIdx: number;
  endIdx: number;
  movingTimeS: number;
  distanceM: number;
  hrSum: number;
  hrW: number;
  cadSum: number;
  cadW: number;
  wattsSum: number;
  wattsW: number;
}

function aggregate(
  streams: IntervalStreams,
  start: number,
  end: number,
): Aggregates {
  const { time, distance, moving, heartrate, cadence, watts } = streams;
  const agg: Aggregates = {
    startIdx: start,
    endIdx: end,
    movingTimeS: 0,
    distanceM: distance[end]! - distance[start]!,
    hrSum: 0,
    hrW: 0,
    cadSum: 0,
    cadW: 0,
    wattsSum: 0,
    wattsW: 0,
  };
  for (let i = start + 1; i <= end; i++) {
    const dt = time[i]! - time[i - 1]!;
    if (dt <= 0) continue;
    if (moving && moving[i] === false) continue;
    const weight = Math.min(dt, MAX_SAMPLE_GAP_SECONDS);
    agg.movingTimeS += weight;
    const hr = heartrate?.[i];
    if (hr != null && hr > 0) {
      agg.hrSum += hr * weight;
      agg.hrW += weight;
    }
    const cad = cadence?.[i];
    if (cad != null && cad > 0) {
      agg.cadSum += cad * weight;
      agg.cadW += weight;
    }
    // Run power of exactly 0 while moving is a stream dropout, not a real
    // observation; including it drags the average toward zero.
    const w = watts?.[i];
    if (w != null && w > 0) {
      agg.wattsSum += w * weight;
      agg.wattsW += weight;
    }
  }
  return agg;
}

function mergeAggregates(a: Aggregates, b: Aggregates): Aggregates {
  return {
    startIdx: a.startIdx,
    endIdx: b.endIdx,
    movingTimeS: a.movingTimeS + b.movingTimeS,
    distanceM: a.distanceM + b.distanceM,
    hrSum: a.hrSum + b.hrSum,
    hrW: a.hrW + b.hrW,
    cadSum: a.cadSum + b.cadSum,
    cadW: a.cadW + b.cadW,
    wattsSum: a.wattsSum + b.wattsSum,
    wattsW: a.wattsW + b.wattsW,
  };
}

function avgSpeed(agg: Aggregates): number {
  return agg.movingTimeS > 0 ? agg.distanceM / agg.movingTimeS : 0;
}

function toRep(
  agg: Aggregates,
  index: number,
  streams: IntervalStreams,
): WorkRep {
  const speed = avgSpeed(agg);
  return {
    index,
    startKm: round(streams.distance[agg.startIdx]! / 1000),
    distanceM: Math.round(agg.distanceM),
    movingTimeS: Math.round(agg.movingTimeS),
    paceSecPerKm: speed > 0 ? Math.round(1000 / speed) : null,
    avgHr: agg.hrW > 0 ? round(agg.hrSum / agg.hrW, 0) : null,
    avgCadence: agg.cadW > 0 ? round(agg.cadSum / agg.cadW, 1) : null,
    // Omit power when coverage is too thin to be meaningful — a rep sitting in
    // a power-stream gap should report no power, not a skewed one.
    avgWatts:
      agg.wattsW > 0 &&
      agg.movingTimeS > 0 &&
      agg.wattsW / agg.movingTimeS >= POWER_COVERAGE_MIN
        ? round(agg.wattsSum / agg.wattsW, 0)
        : null,
  };
}

interface RawRest {
  startIdx: number;
  endIdx: number;
  startTimeS: number;
  durationS: number;
}

/** Contiguous stopped spans from the moving stream, ignoring brief blips. */
export function detectRests(streams: IntervalStreams): RawRest[] {
  const { time, moving } = streams;
  if (!moving) return [];
  const rests: RawRest[] = [];
  let start = -1;
  for (let i = 0; i < moving.length; i++) {
    if (moving[i] === false) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const startTimeS = time[Math.max(0, start - 1)]!;
      const durationS = time[i - 1]! - startTimeS;
      if (durationS >= MIN_REST_SECONDS) {
        rests.push({ startIdx: start, endIdx: i - 1, startTimeS, durationS });
      }
      start = -1;
    }
  }
  if (start >= 0) {
    const startTimeS = time[Math.max(0, start - 1)]!;
    const durationS = time[time.length - 1]! - startTimeS;
    if (durationS >= MIN_REST_SECONDS) {
      rests.push({
        startIdx: start,
        endIdx: time.length - 1,
        startTimeS,
        durationS,
      });
    }
  }
  return rests;
}

/**
 * The documented rest heuristic:
 * - longer than 5 min → café/regroup stop, excluded from structure
 * - fast preceding effort and ≤ 3 min → genuine interval recovery
 * - under 60 s with no fast preceding effort → traffic light, excluded
 * - anything else → unclassified stop, excluded
 */
export function classifyRest(
  durationS: number,
  precedingFast: boolean,
): { kind: RestKind; reason: string } {
  if (durationS > REST_LONG_STOP_MIN_SECONDS) {
    return {
      kind: "long_stop",
      reason: `stopped ${Math.round(durationS / 60)} min — café/regroup/kit stop, excluded from structure`,
    };
  }
  if (precedingFast && durationS <= REST_RECOVERY_MAX_SECONDS) {
    return {
      kind: "recovery",
      reason: `${Math.round(durationS)} s rest after a fast effort — interval recovery`,
    };
  }
  if (durationS < REST_URBAN_MAX_SECONDS) {
    return {
      kind: "traffic_light",
      reason: `${Math.round(durationS)} s stop with no fast effort before it — traffic light, excluded`,
    };
  }
  return {
    kind: "other_stop",
    reason: `${Math.round(durationS)} s stop that fits neither recovery nor traffic-light patterns — excluded`,
  };
}

/**
 * Clean structured laps: at least 3 laps, at least 2 clearly-fast work laps,
 * and the work laps tightly clustered in speed. Corrupted auto-laps (rain,
 * sweat) fail the cluster test and fall back to streams.
 */
export function selectCleanWorkLaps(laps: IntervalLap[]): IntervalLap[] | null {
  if (laps.length < 3) return null;
  const speeds = laps
    .map(
      (l) =>
        l.avgSpeedMs ?? (l.movingTimeS > 0 ? l.distanceM / l.movingTimeS : 0),
    )
    .filter((s) => s > 0);
  if (speeds.length !== laps.length) return null;
  const sorted = [...speeds].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const work = laps.filter(
    (_lap, i) => speeds[i]! >= FAST_SEGMENT_FACTOR * median,
  );
  if (work.length < 2) return null;
  const workSpeeds = work.map(
    (l) => l.avgSpeedMs ?? l.distanceM / l.movingTimeS,
  );
  const mean = workSpeeds.reduce((a, b) => a + b, 0) / workSpeeds.length;
  const variance =
    workSpeeds.reduce((sum, s) => sum + (s - mean) ** 2, 0) / workSpeeds.length;
  const cov = mean > 0 ? Math.sqrt(variance) / mean : 1;
  return cov <= CLEAN_LAP_SPEED_COV ? work : null;
}

function lapReps(laps: IntervalLap[], work: IntervalLap[]): WorkRep[] {
  const startKmByLap = new Map<number, number>();
  let cumulative = 0;
  for (const lap of [...laps].sort((a, b) => a.lapIndex - b.lapIndex)) {
    startKmByLap.set(lap.lapIndex, cumulative / 1000);
    cumulative += lap.distanceM;
  }
  return work.map((lap, i) => {
    const speed =
      lap.avgSpeedMs ??
      (lap.movingTimeS > 0 ? lap.distanceM / lap.movingTimeS : 0);
    return {
      index: i + 1,
      startKm: round(startKmByLap.get(lap.lapIndex) ?? 0),
      distanceM: Math.round(lap.distanceM),
      movingTimeS: Math.round(lap.movingTimeS),
      paceSecPerKm: speed > 0 ? Math.round(1000 / speed) : null,
      avgHr: lap.avgHr != null ? round(lap.avgHr, 0) : null,
      avgCadence: lap.avgCadence != null ? round(lap.avgCadence, 1) : null,
      avgWatts: lap.avgWatts != null ? round(lap.avgWatts, 0) : null,
    };
  });
}

/** Pace/HR/cadence drift across reps: last rep vs first. */
export function computeFade(reps: WorkRep[]): IntervalFade | null {
  if (reps.length < 2) return null;
  const first = reps[0]!;
  const last = reps[reps.length - 1]!;

  const paceDriftPct =
    first.paceSecPerKm != null && last.paceSecPerKm != null
      ? round(
          ((last.paceSecPerKm - first.paceSecPerKm) / first.paceSecPerKm) * 100,
          1,
        )
      : null;
  const hrDriftBpm =
    first.avgHr != null && last.avgHr != null
      ? round(last.avgHr - first.avgHr, 0)
      : null;
  const cadenceDriftPct =
    first.avgCadence != null && last.avgCadence != null && first.avgCadence > 0
      ? round(
          ((last.avgCadence - first.avgCadence) / first.avgCadence) * 100,
          1,
        )
      : null;

  const parts: string[] = [];
  if (paceDriftPct != null) {
    parts.push(
      paceDriftPct > 0
        ? `${paceDriftPct}% slower`
        : `${Math.abs(paceDriftPct)}% faster`,
    );
  }
  if (hrDriftBpm != null && hrDriftBpm !== 0) {
    parts.push(
      `at ${Math.abs(hrDriftBpm)} bpm ${hrDriftBpm > 0 ? "higher" : "lower"} HR`,
    );
  }
  if (cadenceDriftPct != null && Math.abs(cadenceDriftPct) >= 1) {
    parts.push(
      `cadence ${Math.abs(cadenceDriftPct)}% ${cadenceDriftPct > 0 ? "up" : "down"}`,
    );
  }
  const summary =
    parts.length > 0
      ? `rep ${last.index} was ${parts.join(", ")} than rep ${first.index}`
      : `no measurable drift between rep ${first.index} and rep ${last.index}`;

  return { paceDriftPct, hrDriftBpm, cadenceDriftPct, summary };
}

/**
 * The "was this a workout at all" tiebreaker: share of time at ≥ 88% of the
 * activity's own max HR.
 */
export function computeHrSignal(streams: IntervalStreams): HrSignal | null {
  const { time, heartrate, moving } = streams;
  if (!heartrate || heartrate.length === 0) return null;
  let maxHr = 0;
  for (const hr of heartrate) if (hr != null && hr > maxHr) maxHr = hr;
  if (maxHr <= 0) return null;

  const threshold = maxHr * 0.88;
  let total = 0;
  let high = 0;
  for (let i = 1; i < time.length; i++) {
    const dt = time[i]! - time[i - 1]!;
    if (dt <= 0) continue;
    if (moving && moving[i] === false) continue;
    const weight = Math.min(dt, MAX_SAMPLE_GAP_SECONDS);
    total += weight;
    const hr = heartrate[i];
    if (hr != null && hr >= threshold) high += weight;
  }
  if (total <= 0) return null;

  const share = high / total;
  const assessment =
    share >= HR_HIGH_INTENSITY_SHARE
      ? "substantial time near max HR — consistent with a hard workout"
      : share < 0.05
        ? "little time near max HR — consistent with an easy continuous effort"
        : "moderate time near max HR — ambiguous between tempo and intervals";
  return { maxHr, highIntensityShare: round(share, 3), assessment };
}

export function computeIntervalAnalysis(
  streams: IntervalStreams,
  laps: IntervalLap[] = [],
): IntervalAnalysis {
  if (!streams.time || streams.time.length < 2 || !streams.distance) {
    throw new IntervalAnalysisError(
      "The activity's time and distance streams are required for interval analysis.",
    );
  }

  const warnings: string[] = [];
  if (!streams.moving) {
    warnings.push(
      "No moving stream; stopped/rest segments could not be detected.",
    );
  }
  if (!streams.heartrate) {
    warnings.push(
      "No heart rate stream; HR fade and the workout tiebreaker are unavailable.",
    );
  }

  // `distance` drives index-based windowing below and must be fully
  // populated; every other stream keeps null samples as "no data" and is
  // skipped where consumed (see `aggregate`/`computeHrSignal`).
  const normalized: IntervalStreams = {
    ...streams,
    distance: interpolateNulls(streams.distance),
  };

  // --- Rest detection and classification (stream path) ---
  const rawRests = detectRests(normalized);

  // Work segments between rests.
  const boundaries: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const rest of rawRests) {
    if (rest.startIdx - 1 > cursor) {
      boundaries.push({ start: cursor, end: rest.startIdx - 1 });
    }
    cursor = rest.endIdx;
  }
  if (cursor < normalized.time.length - 1) {
    boundaries.push({ start: cursor, end: normalized.time.length - 1 });
  }

  const segments = boundaries.map((b) => aggregate(normalized, b.start, b.end));
  const totalMoving = segments.reduce((sum, s) => sum + s.movingTimeS, 0);
  const totalDistance = segments.reduce((sum, s) => sum + s.distanceM, 0);
  const overallSpeed = totalMoving > 0 ? totalDistance / totalMoving : 0;
  const isFast = (agg: Aggregates) =>
    overallSpeed > 0 && avgSpeed(agg) >= FAST_SEGMENT_FACTOR * overallSpeed;

  const rests: RestSegment[] = rawRests.map((rest, i) => {
    const preceding = segments[i];
    const precedingFast = preceding != null && isFast(preceding);
    const { kind, reason } = classifyRest(rest.durationS, precedingFast);
    return {
      startTimeS: Math.round(rest.startTimeS),
      durationS: Math.round(rest.durationS),
      atKm: round(normalized.distance[rest.startIdx]! / 1000),
      kind,
      reason,
    };
  });

  // Merge work segments across traffic lights when both sides run at the
  // same intensity (a light mid-rep or mid-easy-run must not split a block).
  const blocks: Aggregates[] = [];
  for (let i = 0; i < segments.length; i++) {
    const prev = blocks[blocks.length - 1];
    const restBefore = rests[i - 1];
    if (
      prev &&
      restBefore &&
      restBefore.kind === "traffic_light" &&
      isFast(prev) === isFast(segments[i]!)
    ) {
      blocks[blocks.length - 1] = mergeAggregates(prev, segments[i]!);
    } else {
      blocks.push(segments[i]!);
    }
  }

  const streamReps = blocks
    .filter((b) => isFast(b) && b.movingTimeS > 0)
    .map((b, i) => toRep(b, i + 1, normalized));

  // --- Lap path: prefer clean structured laps when they exist ---
  const cleanWork = selectCleanWorkLaps(laps);
  const source: "laps" | "streams" | "none" = cleanWork
    ? "laps"
    : streamReps.length > 0
      ? "streams"
      : "none";
  const reps = cleanWork ? lapReps(laps, cleanWork) : streamReps;

  const recoveries = rests.filter((r) => r.kind === "recovery").length;
  const isIntervals =
    source === "laps" ? reps.length >= 2 : reps.length >= 2 && recoveries >= 1;

  const fade = isIntervals ? computeFade(reps) : null;
  const hrSignal = computeHrSignal(streams);

  // --- Confidence and reasoning ---
  const counts: Record<RestKind, number> = {
    traffic_light: 0,
    recovery: 0,
    long_stop: 0,
    other_stop: 0,
  };
  for (const rest of rests) counts[rest.kind]++;

  let confidence: "high" | "medium" | "low" = "high";
  if (!streams.moving && !cleanWork) confidence = "low";
  else if (source === "streams" && counts.other_stop > 0) confidence = "medium";
  else if (!streams.heartrate) confidence = "medium";
  const workoutSignal =
    hrSignal != null && hrSignal.highIntensityShare >= HR_HIGH_INTENSITY_SHARE;
  if (!isIntervals && workoutSignal && confidence === "high") {
    confidence = "medium";
  }

  const reasonBits = [
    `${rests.length} rests detected` +
      (rests.length > 0
        ? ` (${counts.traffic_light} traffic lights, ${counts.recovery} interval recoveries, ${counts.long_stop} long stops, ${counts.other_stop} unclassified)`
        : ""),
    source === "laps"
      ? `${reps.length} work reps taken from clean structured laps`
      : source === "streams"
        ? `${reps.length} work reps reconstructed from stream work/rest boundaries`
        : "no work reps found",
  ];
  if (!isIntervals && workoutSignal) {
    reasonBits.push(
      "HR distribution suggests hard work despite no interval structure — possibly a tempo/race effort",
    );
  }

  return {
    isIntervals,
    source,
    reps,
    rests,
    fade,
    hrSignal,
    confidence,
    reasoning: reasonBits.join("; "),
    warnings,
  };
}
