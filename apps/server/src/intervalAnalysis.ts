import { hasRealSample, interpolateNulls } from "./hillAnalysis";

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
 * Rests are paired with the work segment that ends right before them, by
 * adjacency, so a standing start cannot shift every later pairing (#47).
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
  /** intervals.icu's own label (`WORK`/`RECOVERY`), when present. */
  type?: string | null;
  /**
   * intervals.icu's interval intensity, a whole percent of the sport's
   * threshold, when present (docs/api-notes.md).
   */
  intensity?: number | null;
}

/**
 * The athlete's heart-rate settings as recorded on the activity. The
 * near-max threshold comes from these, never from the run's own peak: on an
 * easy run the peak is low, so most of the run would read as "near max".
 */
export interface AthleteHr {
  /** The activity's `athlete_max_hr`. */
  athleteMaxHr?: number | null;
  /** The activity's `icu_hr_zones` (ascending upper bounds, last = max HR). */
  hrZones?: number[] | null;
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
/** "Near max HR" starts at this fraction of the athlete's max HR. */
export const HR_NEAR_MAX_FRACTION = 0.88;
/**
 * Laps shorter than this (metres or seconds) are slivers, such as the 0 m
 * lap an Apple Watch often records at the end: ignored, not a reason to
 * give up on the lap set.
 */
export const MIN_LAP_DISTANCE_M = 50;
export const MIN_LAP_SECONDS = 15;
/** A lap within this fraction of 1 km or 1 mile has an auto-lap distance. */
const AUTO_LAP_TOLERANCE = 0.03;
/** Share of full laps at an auto-lap distance that marks an auto-lap set. */
const AUTO_LAP_SHARE = 0.7;
/**
 * On an auto-lap set a fast lap can be a downhill km, so without matching
 * WORK/RECOVERY labels it takes this many fast blocks, each at least this
 * multiple of the slower laps' speed, to count as intervals.
 */
export const AUTO_LAP_MIN_BLOCKS = 3;
export const AUTO_LAP_FAST_FACTOR = 1.15;
/**
 * At the outer edge of the first and the last fast block, a lap slower than
 * this fraction of the other blocks' median speed is a warm-up or
 * cool-down lap, not part of a rep. With walk or slow-jog recoveries the
 * median lap is slow, so a steady warm-up or cool-down lap crosses the fast
 * threshold, alone or merged with the rep next to it (#84).
 */
export const EDGE_LAP_SPEED_FACTOR = 0.8;
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
  /** Time-weighted mean of the laps' intensity, rounded; null for stream reps. */
  intensityPct: number | null;
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

/**
 * Where `HrSignal.maxHr` came from: the activity's `athlete_max_hr`, the
 * last `icu_hr_zones` bound, or (last resort) this run's own peak.
 */
export type MaxHrSource = "athlete_max_hr" | "hr_zones" | "activity_peak";

export interface HrSignal {
  maxHr: number;
  maxHrSource: MaxHrSource;
  /** Share (0–1) of moving time at ≥ 88% of `maxHr`. */
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
    intensityPct: null,
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
      reason: `stopped ${Math.round(durationS / 60)} min: café/regroup/kit stop, excluded from structure`,
    };
  }
  if (precedingFast && durationS <= REST_RECOVERY_MAX_SECONDS) {
    return {
      kind: "recovery",
      reason: `${Math.round(durationS)} s rest after a fast effort: interval recovery`,
    };
  }
  if (durationS < REST_URBAN_MAX_SECONDS) {
    return {
      kind: "traffic_light",
      reason: `${Math.round(durationS)} s stop with no fast effort before it: traffic light, excluded`,
    };
  }
  return {
    kind: "other_stop",
    reason: `${Math.round(durationS)} s stop that fits neither recovery nor traffic-light patterns: excluded`,
  };
}

const lapSpeed = (lap: IntervalLap) =>
  lap.avgSpeedMs ?? (lap.movingTimeS > 0 ? lap.distanceM / lap.movingTimeS : 0);

/** A sliver lap (under 50 m or 15 s, or no speed): ignored, not fatal. */
const isSliverLap = (lap: IntervalLap) =>
  lap.distanceM < MIN_LAP_DISTANCE_M ||
  lap.movingTimeS < MIN_LAP_SECONDS ||
  !(lapSpeed(lap) > 0);

/** Distance over time across a run of laps (a block, or the laps between). */
function blockSpeed(block: IntervalLap[]): number {
  if (block.length === 1) return lapSpeed(block[0]!);
  const time = block.reduce((sum, l) => sum + l.movingTimeS, 0);
  const distance = block.reduce((sum, l) => sum + l.distanceM, 0);
  return time > 0 ? distance / time : 0;
}

/** The upper median: for an even count, the higher of the two middle values. */
function upperMedian(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

/**
 * True when most full laps (all but the last, which is usually partial) sit
 * at 1 km or 1 mile: the device split the run by distance, not by effort.
 */
function isAutoLapSet(laps: IntervalLap[]): boolean {
  const full = laps.slice(0, -1);
  if (full.length < 3) return false;
  const atAutoDistance = full.filter((lap) =>
    [1000, 1609.34].some(
      (d) => Math.abs(lap.distanceM - d) <= d * AUTO_LAP_TOLERANCE,
    ),
  ).length;
  return atAutoDistance / full.length >= AUTO_LAP_SHARE;
}

export interface CleanLapSet {
  /** Work reps: runs of consecutive fast laps, in lap order. */
  blocks: IntervalLap[][];
  /**
   * intervals.icu's WORK/RECOVERY labels against the speed split: `agree`
   * when every fast lap is WORK and every lap between blocks is RECOVERY,
   * `none` when the laps do not carry both labels.
   */
  labels: "agree" | "disagree" | "none";
  autoLaps: boolean;
  /** Sliver laps left out of the analysis. */
  slivers: number;
  /** Warm-up or cool-down laps cut from the edge of the first or last block. */
  edgeLapsDropped: number;
}

/**
 * Clean structured laps. Sliver laps are dropped first. Consecutive fast
 * laps (≥ 1.08 × the median lap speed) merge into one block, and it takes
 * at least 2 blocks with slower laps between them, their speeds tightly
 * clustered. Corrupted laps (rain, sweat) fail the cluster test and fall
 * back to streams. An auto-lap set (1 km or 1 mile laps) needs matching
 * WORK/RECOVERY labels, or 3 blocks clearly faster than the laps between,
 * because a fast auto-lap is often only a downhill km. With 3 or more
 * blocks, a slow lap at the outer edge of the first or the last block is a
 * warm-up or cool-down lap, and it is cut before the cluster test
 * ({@link EDGE_LAP_SPEED_FACTOR}).
 */
export function selectCleanWorkLaps(laps: IntervalLap[]): CleanLapSet | null {
  const ordered = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);
  const valid = ordered.filter((lap) => !isSliverLap(lap));
  if (valid.length < 3) return null;
  const speeds = valid.map(lapSpeed);
  const median = upperMedian(speeds);
  const fast = speeds.map((s) => s >= FAST_SEGMENT_FACTOR * median);

  const blocks: IntervalLap[][] = [];
  /** `gaps[k]`: the slower laps between block k and block k + 1. */
  const gaps: IntervalLap[][] = [];
  let pending: IntervalLap[] = [];
  valid.forEach((lap, i) => {
    if (fast[i]) {
      if (i > 0 && fast[i - 1]) blocks[blocks.length - 1]!.push(lap);
      else {
        if (blocks.length > 0) gaps.push(pending);
        blocks.push([lap]);
      }
      pending = [];
    } else {
      pending.push(lap);
    }
  });

  // Cut laps, not whole blocks: a warm-up lap that runs straight into rep 1
  // merges with it into one block, and dropping the block would lose rep 1.
  // The last block goes first (a cool-down is the common case). Each check
  // needs 3 blocks, so at least 2 remain.
  let edgeLapsDropped = 0;
  if (blocks.length >= 3) {
    const last = blocks[blocks.length - 1]!;
    const others = upperMedian(blocks.slice(0, -1).map(blockSpeed));
    while (
      last.length > 0 &&
      lapSpeed(last[last.length - 1]!) < EDGE_LAP_SPEED_FACTOR * others
    ) {
      last.pop();
      edgeLapsDropped++;
    }
    if (last.length === 0) {
      blocks.pop();
      gaps.pop();
    }
  }
  if (blocks.length >= 3) {
    const first = blocks[0]!;
    const others = upperMedian(blocks.slice(1).map(blockSpeed));
    while (
      first.length > 0 &&
      lapSpeed(first[0]!) < EDGE_LAP_SPEED_FACTOR * others
    ) {
      first.shift();
      edgeLapsDropped++;
    }
    if (first.length === 0) {
      blocks.shift();
      gaps.shift();
    }
  }
  if (blocks.length < 2) return null;
  const between = gaps.flat();

  const blockSpeeds = blocks.map(blockSpeed);
  const mean = blockSpeeds.reduce((a, b) => a + b, 0) / blockSpeeds.length;
  const variance =
    blockSpeeds.reduce((sum, s) => sum + (s - mean) ** 2, 0) /
    blockSpeeds.length;
  const cov = mean > 0 ? Math.sqrt(variance) / mean : 1;
  if (cov > CLEAN_LAP_SPEED_COV) return null;

  const hasLabels =
    valid.some((lap) => lap.type === "WORK") &&
    valid.some((lap) => lap.type === "RECOVERY");
  const labels: CleanLapSet["labels"] = !hasLabels
    ? "none"
    : blocks.every((block) => block.every((lap) => lap.type === "WORK")) &&
        between.every((lap) => lap.type === "RECOVERY")
      ? "agree"
      : "disagree";

  const autoLaps = isAutoLapSet(valid);
  if (autoLaps && labels !== "agree") {
    const slowSpeed = blockSpeed(between);
    const clearlyFaster = blockSpeeds.every(
      (s) => slowSpeed > 0 && s >= AUTO_LAP_FAST_FACTOR * slowSpeed,
    );
    if (blocks.length < AUTO_LAP_MIN_BLOCKS || !clearlyFaster) return null;
  }

  return {
    blocks,
    labels,
    autoLaps,
    slivers: laps.length - valid.length,
    edgeLapsDropped,
  };
}

/** Time-weighted mean of one lap field across a block, skipping nulls. */
function blockMean(
  block: IntervalLap[],
  field: "avgHr" | "avgCadence" | "avgWatts" | "intensity",
): number | null {
  let sum = 0;
  let weight = 0;
  for (const lap of block) {
    const value = lap[field];
    if (value == null) continue;
    sum += value * lap.movingTimeS;
    weight += lap.movingTimeS;
  }
  return weight > 0 ? sum / weight : null;
}

function lapReps(laps: IntervalLap[], blocks: IntervalLap[][]): WorkRep[] {
  const startKmByLap = new Map<number, number>();
  let cumulative = 0;
  for (const lap of [...laps].sort((a, b) => a.lapIndex - b.lapIndex)) {
    startKmByLap.set(lap.lapIndex, cumulative / 1000);
    cumulative += lap.distanceM;
  }
  return blocks.map((block, i) => {
    const speed = blockSpeed(block);
    const hr = blockMean(block, "avgHr");
    const cadence = blockMean(block, "avgCadence");
    const watts = blockMean(block, "avgWatts");
    const intensity = blockMean(block, "intensity");
    return {
      index: i + 1,
      startKm: round(startKmByLap.get(block[0]!.lapIndex) ?? 0),
      distanceM: Math.round(block.reduce((sum, l) => sum + l.distanceM, 0)),
      movingTimeS: Math.round(block.reduce((sum, l) => sum + l.movingTimeS, 0)),
      paceSecPerKm: speed > 0 ? Math.round(1000 / speed) : null,
      avgHr: hr != null ? round(hr, 0) : null,
      avgCadence: cadence != null ? round(cadence, 1) : null,
      avgWatts: watts != null ? round(watts, 0) : null,
      intensityPct: intensity != null ? round(intensity, 0) : null,
    };
  });
}

/**
 * Work reps from laps alone, with the same rules as the lap path of
 * {@link computeIntervalAnalysis}, or null when the laps show no clean reps.
 * The similar-session search reads candidates this way: one bulk read
 * carries their laps, not their streams.
 */
export function repsFromLaps(laps: IntervalLap[]): WorkRep[] | null {
  const clean = selectCleanWorkLaps(laps);
  return clean ? lapReps(laps, clean.blocks) : null;
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
 * The athlete's max HR from the activity: `athlete_max_hr`, else the last
 * `icu_hr_zones` bound (intervals.icu sets it to max HR). Null when neither
 * is recorded.
 */
export function resolveAthleteMaxHr(
  athlete: AthleteHr,
): { maxHr: number; source: MaxHrSource } | null {
  if (athlete.athleteMaxHr != null && athlete.athleteMaxHr > 0) {
    return { maxHr: athlete.athleteMaxHr, source: "athlete_max_hr" };
  }
  const zoneTop = athlete.hrZones?.[athlete.hrZones.length - 1];
  if (zoneTop != null && zoneTop > 0) {
    return { maxHr: zoneTop, source: "hr_zones" };
  }
  return null;
}

/**
 * The "was this a workout at all" tiebreaker: share of moving time at
 * ≥ 88% of the athlete's max HR. Without an athlete max HR it falls back to
 * this run's own peak, which cannot tell easy from hard (on an easy run the
 * peak is low too), so that assessment says so and makes no call.
 */
export function computeHrSignal(
  streams: IntervalStreams,
  athlete: AthleteHr = {},
): HrSignal | null {
  const { time, heartrate, moving } = streams;
  if (!heartrate || heartrate.length === 0) return null;
  let peakHr = 0;
  for (const hr of heartrate) if (hr != null && hr > peakHr) peakHr = hr;
  if (peakHr <= 0) return null;
  const resolved = resolveAthleteMaxHr(athlete) ?? {
    maxHr: peakHr,
    source: "activity_peak" as const,
  };
  const { maxHr } = resolved;

  const threshold = maxHr * HR_NEAR_MAX_FRACTION;
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
    resolved.source === "activity_peak"
      ? "no athlete max HR recorded: time near this run's own peak cannot tell an easy run from a hard one"
      : share >= HR_HIGH_INTENSITY_SHARE
        ? "substantial time near max HR: consistent with a hard workout"
        : share < 0.05
          ? "little time near max HR: consistent with an easy continuous effort"
          : "moderate time near max HR: ambiguous between tempo and intervals";
  return {
    maxHr,
    maxHrSource: resolved.source,
    highIntensityShare: round(share, 3),
    assessment,
  };
}

export function computeIntervalAnalysis(
  streams: IntervalStreams,
  laps: IntervalLap[] = [],
  athlete: AthleteHr = {},
): IntervalAnalysis {
  if (
    !streams.time ||
    streams.time.length < 2 ||
    !hasRealSample(streams.distance)
  ) {
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

  // Work segments and rests in one ordered pass. Each rest records the
  // segment that ends right before it (none for a stop before any
  // movement), and each segment the rest right before it. Pairing them by
  // array position instead judged every rest by the segment after it once
  // the first rest had no segment before it (#47).
  const segments: Aggregates[] = [];
  const segmentRestBefore: Array<number | null> = [];
  const restSegmentBefore: Array<number | null> = [];
  let cursor = 0;
  let lastRest: number | null = null;
  rawRests.forEach((rest, r) => {
    if (rest.startIdx - 1 > cursor) {
      segments.push(aggregate(normalized, cursor, rest.startIdx - 1));
      segmentRestBefore.push(lastRest);
      restSegmentBefore.push(segments.length - 1);
    } else {
      restSegmentBefore.push(null);
    }
    lastRest = r;
    cursor = rest.endIdx;
  });
  if (cursor < normalized.time.length - 1) {
    segments.push(aggregate(normalized, cursor, normalized.time.length - 1));
    segmentRestBefore.push(lastRest);
  }

  const totalMoving = segments.reduce((sum, s) => sum + s.movingTimeS, 0);
  const totalDistance = segments.reduce((sum, s) => sum + s.distanceM, 0);
  const overallSpeed = totalMoving > 0 ? totalDistance / totalMoving : 0;
  const isFast = (agg: Aggregates) =>
    overallSpeed > 0 && avgSpeed(agg) >= FAST_SEGMENT_FACTOR * overallSpeed;

  // A stop before any movement is a standing start (waiting for GPS), not
  // a rest in the session: it is left out of the rests entirely.
  const standingStart =
    rawRests.length > 0 && restSegmentBefore[0] === null ? rawRests[0]! : null;
  const classified = rawRests.map((rest, r) => {
    const before = restSegmentBefore[r];
    const precedingFast = before != null && isFast(segments[before]!);
    const { kind, reason } = classifyRest(rest.durationS, precedingFast);
    return {
      startTimeS: Math.round(rest.startTimeS),
      durationS: Math.round(rest.durationS),
      atKm: round(normalized.distance[rest.startIdx]! / 1000),
      kind,
      reason,
    } satisfies RestSegment;
  });
  const rests = standingStart ? classified.slice(1) : classified;

  // Merge work segments across traffic lights when both sides run at the
  // same intensity (a light mid-rep or mid-easy-run must not split a block).
  const blocks: Aggregates[] = [];
  segments.forEach((segment, i) => {
    const prev = blocks[blocks.length - 1];
    const restBefore = segmentRestBefore[i];
    if (
      prev &&
      restBefore != null &&
      classified[restBefore]!.kind === "traffic_light" &&
      isFast(prev) === isFast(segment)
    ) {
      blocks[blocks.length - 1] = mergeAggregates(prev, segment);
    } else {
      blocks.push(segment);
    }
  });

  const streamReps = blocks
    .filter((b) => isFast(b) && b.movingTimeS > 0)
    .map((b, i) => toRep(b, i + 1, normalized));

  // --- Lap path: prefer clean structured laps when they exist ---
  const cleanLaps = selectCleanWorkLaps(laps);
  const source: "laps" | "streams" | "none" = cleanLaps
    ? "laps"
    : streamReps.length > 0
      ? "streams"
      : "none";
  const reps = cleanLaps ? lapReps(laps, cleanLaps.blocks) : streamReps;

  const recoveries = rests.filter((r) => r.kind === "recovery").length;
  const isIntervals =
    source === "laps" ? reps.length >= 2 : reps.length >= 2 && recoveries >= 1;

  const fade = isIntervals ? computeFade(reps) : null;
  const hrSignal = computeHrSignal(streams, athlete);
  if (hrSignal?.maxHrSource === "activity_peak") {
    warnings.push(
      "The activity has no athlete max HR or HR zones; the HR signal is measured against this run's own peak and is not used as evidence.",
    );
  }

  // --- Confidence and reasoning ---
  const counts: Record<RestKind, number> = {
    traffic_light: 0,
    recovery: 0,
    long_stop: 0,
    other_stop: 0,
  };
  for (const rest of rests) counts[rest.kind]++;

  let confidence: "high" | "medium" | "low" = "high";
  if (!streams.moving && !cleanLaps) confidence = "low";
  else if (source === "streams" && counts.other_stop > 0) confidence = "medium";
  else if (source === "laps" && cleanLaps?.labels === "disagree") {
    confidence = "medium";
  } else if (!streams.heartrate) confidence = "medium";
  const workoutSignal =
    hrSignal != null &&
    hrSignal.maxHrSource !== "activity_peak" &&
    hrSignal.highIntensityShare >= HR_HIGH_INTENSITY_SHARE;
  if (!isIntervals && workoutSignal && confidence === "high") {
    confidence = "medium";
  }

  const reasonBits = [
    `${rests.length} rests detected` +
      (rests.length > 0
        ? ` (${counts.traffic_light} traffic lights, ${counts.recovery} interval recoveries, ${counts.long_stop} long stops, ${counts.other_stop} unclassified)`
        : ""),
  ];
  if (standingStart) {
    reasonBits.push(
      `${Math.round(standingStart.durationS)} s standing start ignored`,
    );
  }
  if (cleanLaps) {
    const lapBits = [
      `${reps.length} work reps taken from clean structured laps`,
    ];
    if (cleanLaps.labels === "agree") {
      lapBits.push("WORK/RECOVERY labels agree");
    } else if (cleanLaps.labels === "disagree") {
      lapBits.push("WORK/RECOVERY labels do not match the fast laps");
    }
    if (cleanLaps.autoLaps) lapBits.push("laps are 1 km or 1 mile auto-laps");
    if (cleanLaps.edgeLapsDropped > 0) {
      const n = cleanLaps.edgeLapsDropped;
      lapBits.push(
        `${n} slow lap${n === 1 ? "" : "s"} at the edge (warm-up, cool-down or a much slower last rep) not counted in a rep`,
      );
    }
    if (cleanLaps.slivers > 0) {
      lapBits.push(
        `${cleanLaps.slivers} sliver lap${cleanLaps.slivers === 1 ? "" : "s"} ignored`,
      );
    }
    reasonBits.push(lapBits.join(", "));
  } else {
    reasonBits.push(
      source === "streams"
        ? `${reps.length} work reps reconstructed from stream work/rest boundaries`
        : "no work reps found",
    );
  }
  if (!isIntervals && workoutSignal) {
    reasonBits.push(
      "HR distribution suggests hard work despite no interval structure: possibly a tempo/race effort",
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
