/**
 * Equivalent-performance and goal-pace math for `get-race-prediction`.
 * Pure functions over recorded best efforts, unit-tested next to
 * `fitnessTrend.ts`.
 *
 * The model is Riegel's: `T2 = T1 × (D2/D1)^1.06`. Every recorded best effort
 * is extrapolated to the target distance, then combined into one consensus
 * time weighted by how recent the effort is and how far it has to be
 * extrapolated — a 10K from last month says far more about half-marathon
 * fitness than a 1-mile PR from two years ago.
 *
 * Riegel is an extrapolation, not a measurement, so the honest part of the
 * output is the spread and the confidence gate: the caller is told which
 * effort drives the estimate, how much the individual estimates disagree, and
 * why the prediction is or is not trustworthy.
 */

import { type IntervalsAthletePaceCurves } from "./intervalsClient";
import { paceFromDistanceTime } from "./utils/running";

/** Riegel's fatigue exponent. 1.06 is the value from the original paper. */
export const RIEGEL_EXPONENT = 1.06;

/**
 * Efforts shorter than this are excluded as prediction sources. Riegel's fit
 * covers roughly 3:30 to 4 hours of running; extrapolating a marathon from a
 * 400m repeat is arithmetic, not evidence.
 */
export const MIN_SOURCE_DISTANCE_M = 1500;

/** Recency weight halves every this many days. */
export const RECENCY_HALF_LIFE_DAYS = 90;

/** Floor on the recency weight so a lone stale effort still predicts. */
const MIN_RECENCY_WEIGHT = 0.05;

/**
 * Scale for the extrapolation weight, `exp(-|ln(target/source)| / scale)`.
 * At 1.0 a same-distance source weighs 1.0, 10K→half ≈ 0.47, 5K→marathon
 * ≈ 0.12 — steep enough that a nearby effort dominates without silencing the
 * others.
 */
const EXTRAPOLATION_SCALE = 1.0;

/** An effort in the last this-many days counts as a current-form sample. */
export const RECENT_WINDOW_DAYS = 90;

/** Default first-half/second-half offset for the negative-split variant. */
export const NEGATIVE_SPLIT_PCT = 0.01;

/** Named race distances the tool can predict and split. */
export const RACE_DISTANCES = {
  "5K": 5000,
  "10K": 10000,
  "15K": 15000,
  "10 mile": 16093.4,
  "Half Marathon": 21097.5,
  Marathon: 42195,
  "50K": 50000,
} as const;

export type RaceDistanceName = keyof typeof RACE_DISTANCES;

/** Distances always present in the equivalent-performance table. */
export const STANDARD_TARGETS: RaceDistanceName[] = [
  "5K",
  "10K",
  "Half Marathon",
  "Marathon",
];

/** One recorded best effort, normalised out of intervals.icu's pace curves. */
export interface SourceEffort {
  /** A label for the effort, e.g. "5000 m" or a curve activity's name. */
  name: string;
  distanceMeters: number;
  elapsedSeconds: number;
  /** Local calendar date (YYYY-MM-DD) the effort was run. */
  date: string;
  activityId: string;
  activityName: string;
}

/** A source effort extrapolated to one target distance. */
export interface Contribution {
  source: SourceEffort;
  /** Riegel time at the target distance, seconds. */
  predictedSeconds: number;
  /** Age of the source in days, relative to the prediction's reference date. */
  ageDays: number;
  recencyWeight: number;
  extrapolationWeight: number;
  /** recencyWeight × extrapolationWeight. */
  weight: number;
}

export type Confidence = "high" | "medium" | "low";

export interface Prediction {
  label: string;
  distanceMeters: number;
  predictedSeconds: number;
  paceSecPerKm: number;
  confidence: Confidence;
  /** Plain-English reasons the confidence is what it is. */
  confidenceNotes: string[];
  /** The highest-weighted contribution — the effort driving the estimate. */
  primary: Contribution;
  /** Every contribution, highest weight first. */
  contributions: Contribution[];
  /** Disagreement across contributions; null when there is only one. */
  spread: {
    fastestSeconds: number;
    slowestSeconds: number;
    rangeSeconds: number;
    /** Range as a share of the consensus time. */
    rangePct: number;
  } | null;
}

export type SplitUnit = "km";

export interface Split {
  /** 1-based split number. */
  index: number;
  /** Cumulative distance at the end of this split, metres. */
  cumulativeMeters: number;
  /** Length of this split, metres — the last one may be partial. */
  segmentMeters: number;
  splitSeconds: number;
  cumulativeSeconds: number;
  /** Pace over this split, seconds per full km or per full mile. */
  paceSecPerUnit: number;
}

export interface SplitPlan {
  unit: SplitUnit;
  /** 0 for even pacing; 0.01 means first half 1% slower, second 1% faster. */
  negativeSplitPct: number;
  totalSeconds: number;
  splits: Split[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Whole days between two YYYY-MM-DD dates; negative if `date` is later. */
export function daysBetween(date: string, reference: string): number {
  const from = Date.parse(`${date}T00:00:00Z`);
  const to = Date.parse(`${reference}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

/**
 * Riegel's equivalent time at `targetMeters` for an effort of
 * `sourceSeconds` over `sourceMeters`. Returns null for a degenerate source.
 */
export function riegelPredict(
  sourceSeconds: number,
  sourceMeters: number,
  targetMeters: number,
  exponent: number = RIEGEL_EXPONENT,
): number | null {
  if (
    !(sourceSeconds > 0) ||
    !(sourceMeters > 0) ||
    !(targetMeters > 0) ||
    !Number.isFinite(sourceSeconds) ||
    !Number.isFinite(sourceMeters) ||
    !Number.isFinite(targetMeters)
  ) {
    return null;
  }
  return sourceSeconds * (targetMeters / sourceMeters) ** exponent;
}

/**
 * Reduce a pile of recorded efforts to the candidates worth predicting from.
 *
 * Per distance this keeps at most two: the fastest effort ever recorded, and
 * the fastest of the last `RECENT_WINDOW_DAYS` if that is a different run.
 * Keeping both is what stops a two-year-old PR speaking for current fitness
 * on its own while still letting it contribute — the recency weight decides
 * how loudly each one speaks.
 *
 * Efforts under `MIN_SOURCE_DISTANCE_M` are dropped: outside Riegel's range.
 */
export function selectSourceEfforts(
  efforts: readonly SourceEffort[],
  referenceDate: string,
  options: { minDistanceMeters?: number; recentWindowDays?: number } = {},
): SourceEffort[] {
  const minDistance = options.minDistanceMeters ?? MIN_SOURCE_DISTANCE_M;
  const recentWindow = options.recentWindowDays ?? RECENT_WINDOW_DAYS;

  const usable = efforts.filter(
    (effort) =>
      effort.distanceMeters >= minDistance &&
      effort.elapsedSeconds > 0 &&
      Number.isFinite(effort.distanceMeters),
  );

  // Bucket by rounded distance so "10K" efforts recorded as 10000 and 10000.1
  // do not become two separate distances.
  const buckets = new Map<number, SourceEffort[]>();
  for (const effort of usable) {
    const key = Math.round(effort.distanceMeters);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(effort);
    else buckets.set(key, [effort]);
  }

  const selected: SourceEffort[] = [];
  for (const bucket of buckets.values()) {
    const byTime = [...bucket].sort(
      (a, b) => a.elapsedSeconds - b.elapsedSeconds,
    );
    const fastest = byTime[0];
    if (!fastest) continue;
    selected.push(fastest);

    const fastestRecent = byTime.find(
      (effort) =>
        effort !== fastest &&
        daysBetween(effort.date, referenceDate) <= recentWindow,
    );
    // Only when the outright best is itself stale — otherwise the recent
    // candidate is the same run, or slower and more recent by a margin the
    // recency weight would already have applied to the faster one.
    if (
      fastestRecent &&
      daysBetween(fastest.date, referenceDate) > recentWindow
    ) {
      selected.push(fastestRecent);
    }
  }

  return selected.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Weight halving every `RECENCY_HALF_LIFE_DAYS`, floored so nothing vanishes. */
export function recencyWeight(
  ageDays: number,
  halfLifeDays: number = RECENCY_HALF_LIFE_DAYS,
): number {
  const age = Math.max(0, ageDays);
  return Math.max(MIN_RECENCY_WEIGHT, 0.5 ** (age / halfLifeDays));
}

/** Weight falling off with the log-distance gap being extrapolated across. */
export function extrapolationWeight(
  sourceMeters: number,
  targetMeters: number,
): number {
  if (!(sourceMeters > 0) || !(targetMeters > 0)) return 0;
  return Math.exp(
    -Math.abs(Math.log(targetMeters / sourceMeters)) / EXTRAPOLATION_SCALE,
  );
}

/**
 * Grade the prediction. Starts optimistic and demotes on each way the
 * estimate can be wrong: extrapolating well past anything actually run,
 * stale evidence, a single source, or sources that disagree with each other.
 */
export function gradeConfidence(
  contributions: readonly Contribution[],
  targetMeters: number,
  consensusSeconds: number,
): { confidence: Confidence; notes: string[] } {
  const notes: string[] = [];
  if (contributions.length === 0) {
    return { confidence: "low", notes: ["No usable efforts to predict from."] };
  }

  let confidence: Confidence = "high";
  const demoteTo = (level: Confidence) => {
    if (level === "low") confidence = "low";
    else if (confidence === "high") confidence = "medium";
  };

  const longestSource = Math.max(
    ...contributions.map((c) => c.source.distanceMeters),
  );
  const stretch = targetMeters / longestSource;
  if (stretch > 2) {
    demoteTo("low");
    notes.push(
      `Extrapolated ${stretch.toFixed(1)}× beyond your longest recorded effort (${round1(longestSource / 1000)} km): Riegel over-predicts across gaps this wide.`,
    );
  } else if (stretch > 1.3) {
    demoteTo("medium");
    notes.push(
      `Extrapolated ${stretch.toFixed(1)}× beyond your longest recorded effort (${round1(longestSource / 1000)} km).`,
    );
  }

  const primary = contributions[0]!;
  if (primary.ageDays > 180) {
    demoteTo("low");
    notes.push(
      `The effort driving this estimate is ${primary.ageDays} days old: it reflects fitness from ${primary.source.date}, not today.`,
    );
  } else if (primary.ageDays > RECENT_WINDOW_DAYS) {
    demoteTo("medium");
    notes.push(
      `The effort driving this estimate is ${primary.ageDays} days old.`,
    );
  }

  if (contributions.length === 1) {
    demoteTo("medium");
    notes.push(
      "Only one usable effort, so there is nothing to cross-check it against.",
    );
  }

  if (contributions.length > 1 && consensusSeconds > 0) {
    const times = contributions.map((c) => c.predictedSeconds);
    const rangePct =
      ((Math.max(...times) - Math.min(...times)) / consensusSeconds) * 100;
    if (rangePct > 25) {
      demoteTo("low");
      notes.push(
        `Your efforts disagree by ${Math.round(rangePct)}% at this distance: speed and endurance are out of step, so the consensus hides a real range.`,
      );
    } else if (rangePct > 12) {
      demoteTo("medium");
      notes.push(
        `Your efforts disagree by ${Math.round(rangePct)}% at this distance.`,
      );
    }
  }

  if (notes.length === 0) {
    notes.push(
      "Recent efforts at nearby distances agree, so this is a well-supported estimate.",
    );
  }

  return { confidence, notes };
}

/**
 * Predict `targetMeters` from the selected sources. Returns null when no
 * source can produce a finite estimate.
 */
export function predictRace(
  sources: readonly SourceEffort[],
  targetMeters: number,
  label: string,
  referenceDate: string,
): Prediction | null {
  const contributions: Contribution[] = [];

  for (const source of sources) {
    const predictedSeconds = riegelPredict(
      source.elapsedSeconds,
      source.distanceMeters,
      targetMeters,
    );
    if (predictedSeconds === null) continue;

    const ageDays = Math.max(0, daysBetween(source.date, referenceDate));
    const recency = recencyWeight(ageDays);
    const extrapolation = extrapolationWeight(
      source.distanceMeters,
      targetMeters,
    );
    contributions.push({
      source,
      predictedSeconds: Math.round(predictedSeconds),
      ageDays,
      recencyWeight: Math.round(recency * 1000) / 1000,
      extrapolationWeight: Math.round(extrapolation * 1000) / 1000,
      weight: Math.round(recency * extrapolation * 1000) / 1000,
    });
  }

  if (contributions.length === 0) return null;

  contributions.sort((a, b) => b.weight - a.weight);

  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  // Every weight can round to zero for an ancient, wildly-extrapolated
  // source; fall back to an unweighted mean rather than dividing by zero.
  const consensus =
    totalWeight > 0
      ? contributions.reduce(
          (sum, c) => sum + c.predictedSeconds * c.weight,
          0,
        ) / totalWeight
      : contributions.reduce((sum, c) => sum + c.predictedSeconds, 0) /
        contributions.length;

  const predictedSeconds = Math.round(consensus);
  const times = contributions.map((c) => c.predictedSeconds);
  const fastestSeconds = Math.min(...times);
  const slowestSeconds = Math.max(...times);

  const { confidence, notes } = gradeConfidence(
    contributions,
    targetMeters,
    predictedSeconds,
  );

  return {
    label,
    distanceMeters: targetMeters,
    predictedSeconds,
    paceSecPerKm: Math.round((predictedSeconds / targetMeters) * 1000),
    confidence,
    confidenceNotes: notes,
    primary: contributions[0]!,
    contributions,
    spread:
      contributions.length > 1
        ? {
            fastestSeconds,
            slowestSeconds,
            rangeSeconds: slowestSeconds - fastestSeconds,
            rangePct:
              predictedSeconds > 0
                ? round1(
                    ((slowestSeconds - fastestSeconds) / predictedSeconds) *
                      100,
                  )
                : 0,
          }
        : null,
  };
}

/**
 * Cumulative time at `meters` into a race run to `plan`.
 *
 * The negative-split variant runs the first half at `basePace × (1 + pct)`
 * and the second at `basePace × (1 - pct)`, which preserves the total exactly
 * and stays correct for a split that straddles halfway.
 */
function cumulativeSecondsAt(
  meters: number,
  totalSeconds: number,
  distanceMeters: number,
  negativeSplitPct: number,
): number {
  const basePace = totalSeconds / distanceMeters;
  const half = distanceMeters / 2;
  if (meters <= half) {
    return meters * basePace * (1 + negativeSplitPct);
  }
  return (
    half * basePace * (1 + negativeSplitPct) +
    (meters - half) * basePace * (1 - negativeSplitPct)
  );
}

/**
 * Per-km split table for a target time. The final split is the partial
 * remainder (a marathon ends with 195 m), and its pace is stated per full km
 * so it stays comparable with the rows above it.
 */
export function buildSplits(
  totalSeconds: number,
  distanceMeters: number,
  unit: SplitUnit = "km",
  negativeSplitPct = 0,
): SplitPlan {
  const unitMeters = 1000;
  const splits: Split[] = [];

  if (totalSeconds > 0 && distanceMeters > 0) {
    let covered = 0;
    let previousCumulative = 0;
    let index = 0;
    // Guard against a pathological distance producing an unbounded table.
    while (covered < distanceMeters - 0.5 && index < 200) {
      index += 1;
      const cumulativeMeters = Math.min(covered + unitMeters, distanceMeters);
      const segmentMeters = cumulativeMeters - covered;
      const cumulativeSeconds = cumulativeSecondsAt(
        cumulativeMeters,
        totalSeconds,
        distanceMeters,
        negativeSplitPct,
      );
      const splitSeconds = cumulativeSeconds - previousCumulative;
      splits.push({
        index,
        cumulativeMeters: Math.round(cumulativeMeters * 10) / 10,
        segmentMeters: Math.round(segmentMeters * 10) / 10,
        splitSeconds: Math.round(splitSeconds * 10) / 10,
        cumulativeSeconds: Math.round(cumulativeSeconds * 10) / 10,
        paceSecPerUnit:
          segmentMeters > 0
            ? Math.round((splitSeconds / segmentMeters) * unitMeters)
            : 0,
      });
      covered = cumulativeMeters;
      previousCumulative = cumulativeSeconds;
    }
  }

  return {
    unit,
    negativeSplitPct,
    totalSeconds: Math.round(totalSeconds),
    splits,
  };
}

/**
 * Parse a goal time written the way runners write it: "1:45:00", "45:30",
 * "1h45m", or a bare number of seconds. Returns null if it is not a time.
 */
export function parseGoalTime(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const hms = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (hms) {
    const hours = hms[1] ? Number(hms[1]) : 0;
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  const human = trimmed.match(
    /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/,
  );
  if (human && (human[1] || human[2] || human[3])) {
    return (
      Number(human[1] ?? 0) * 3600 +
      Number(human[2] ?? 0) * 60 +
      Number(human[3] ?? 0)
    );
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? Math.round(seconds) : null;
  }

  return null;
}

/** M:SS or H:MM:SS, always zero-padded — split tables need aligned columns. */
export function formatRaceTime(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

/** Pace (km only) for a race time, via the shared distance/time converter
 * (`paceFromDistanceTime`) rather than its own m/s-and-formatting logic. */
export function racePace(
  seconds: number,
  distanceMeters: number,
): { minPerKm: string } | null {
  const minPerKm = paceFromDistanceTime(distanceMeters, seconds);
  return minPerKm ? { minPerKm } : null;
}

/**
 * intervals.icu's `type: "CS"` critical-speed model off a pace-curve list
 * item's `paceModels`: `criticalSpeed` (m/s) and `dPrime` (m) fit an
 * exponential-decay curve to the athlete's own points, alongside Riegel.
 */
export interface CriticalSpeedModel {
  criticalSpeedMetersPerSec: number;
  dPrimeMeters: number;
  r2: number;
}

/** intervals.icu's stated validity window for the critical-speed model:
 * roughly 3 to 60 minutes of racing. A prediction outside this range is
 * still returned by {@link criticalSpeedPredict}, so the caller flags it
 * rather than hiding it. */
export const CS_MODEL_MIN_SECONDS = 180;
export const CS_MODEL_MAX_SECONDS = 3600;

/** `true` when `seconds` falls inside the critical-speed model's stated
 * validity window ({@link CS_MODEL_MIN_SECONDS}-{@link CS_MODEL_MAX_SECONDS}). */
export function isWithinCriticalSpeedValidity(seconds: number): boolean {
  return seconds >= CS_MODEL_MIN_SECONDS && seconds <= CS_MODEL_MAX_SECONDS;
}

/**
 * Reads the `type: "CS"` model off one pace-curve list item's `paceModels`,
 * or `null` when the item is absent or carries no usable CS fit.
 */
export function criticalSpeedModel(
  item: IntervalsAthletePaceCurves["list"][number] | undefined,
): CriticalSpeedModel | null {
  const model = item?.paceModels?.find((m) => m.type === "CS");
  if (
    !model ||
    model.criticalSpeed == null ||
    model.dPrime == null ||
    model.r2 == null ||
    !(model.criticalSpeed > 0) ||
    !(model.dPrime >= 0)
  ) {
    return null;
  }
  return {
    criticalSpeedMetersPerSec: model.criticalSpeed,
    dPrimeMeters: model.dPrime,
    r2: model.r2,
  };
}

/**
 * intervals.icu's critical-speed prediction at `targetMeters`:
 * `(distance - dPrime) / criticalSpeed`. `null` when the target does not
 * exceed `dPrime` (the model has no positive time there), or the result is
 * not finite.
 */
export function criticalSpeedPredict(
  model: CriticalSpeedModel,
  targetMeters: number,
): number | null {
  if (!(targetMeters > model.dPrimeMeters)) return null;
  const seconds =
    (targetMeters - model.dPrimeMeters) / model.criticalSpeedMetersPerSec;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** One list item's index-aligned `distance`/`values`/`activity_id` arrays,
 * turned into {@link SourceEffort}s. Points under `minDistanceMeters`, or
 * with no recorded value or owning activity at that index, are skipped. */
function sourceEffortsFromCurve(
  item: IntervalsAthletePaceCurves["list"][number] | undefined,
  activities: IntervalsAthletePaceCurves["activities"],
  minDistanceMeters: number,
): SourceEffort[] {
  if (!item) return [];
  const efforts: SourceEffort[] = [];
  for (let i = 0; i < item.distance.length; i += 1) {
    const distanceMeters = item.distance[i];
    const elapsedSeconds = item.values[i];
    const activityId = item.activity_id[i];
    if (
      distanceMeters == null ||
      distanceMeters < minDistanceMeters ||
      elapsedSeconds == null ||
      !activityId
    ) {
      continue;
    }
    const activity = activities[activityId];
    efforts.push({
      name: `${Math.round(distanceMeters)} m`,
      distanceMeters,
      elapsedSeconds,
      date: (activity?.start_date_local ?? "").split("T")[0] ?? "",
      activityId,
      activityName: activity?.name ?? "Unknown activity",
    });
  }
  return efforts;
}

/**
 * Adapts intervals.icu's `all`/`90d` athlete pace curves into
 * {@link SourceEffort}s for {@link selectSourceEfforts}: one entry per
 * distance-grid point on each curve, the `all` curve giving the fastest ever
 * at that distance and the `90d` curve the fastest of the last 90 days.
 * `selectSourceEfforts` then keeps, per distance, the fastest of the two
 * (and both when the outright fastest is itself stale) exactly as it does
 * for any other pile of recorded efforts.
 *
 * Takes the already-found `all`/`90d` list items rather than the whole
 * `curves` payload plus a `curves.list.find` of its own, so a caller that
 * also needs {@link criticalSpeedModel} finds each curve once and threads
 * it to both.
 */
export function paceCurveSourceEfforts(
  activities: IntervalsAthletePaceCurves["activities"],
  allCurve: IntervalsAthletePaceCurves["list"][number] | undefined,
  recentCurve: IntervalsAthletePaceCurves["list"][number] | undefined,
  options: { minDistanceMeters?: number } = {},
): SourceEffort[] {
  const minDistance = options.minDistanceMeters ?? MIN_SOURCE_DISTANCE_M;
  return [
    ...sourceEffortsFromCurve(allCurve, activities, minDistance),
    ...sourceEffortsFromCurve(recentCurve, activities, minDistance),
  ];
}
