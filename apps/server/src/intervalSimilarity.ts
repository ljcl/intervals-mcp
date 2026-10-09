import { computeFade, type WorkRep } from "./intervalAnalysis";
import { type IntervalsIntervalSearchQuery } from "./intervalsClient";
import { PACE_ACTIVITY_TYPES } from "./utils/running";

/**
 * The rules that decide whether an earlier session has the same interval
 * structure as this one, for `get-interval-analysis`'s `findSimilar` (#84).
 * Pure functions, one home: the tool builds the interval-search band here,
 * reads each candidate's reps with `repsFromLaps` (the lap rules of its own
 * analysis), and compares them here.
 *
 * intervals.icu's interval search is only a first filter. It searches every
 * sport and all history, also matches recovery intervals, and its rep count
 * does not follow the current laps (docs/api-notes.md). So a candidate
 * matches only when its own laps show the same typical reps.
 */

/** A rep is typical when its moving time is within this fraction of the median rep's. */
export const TYPICAL_REP_TOLERANCE = 0.2;
/** The search's rep-time band: the typical reps' range, widened by this fraction each way. */
export const SEARCH_SECONDS_MARGIN = 0.15;
/** The search's intensity band: the typical reps' range, widened by this many points each way. */
export const SEARCH_INTENSITY_MARGIN = 5;
/** The intensity band when the reps carry no intensity (stream reps). Verified accepted. */
export const SEARCH_INTENSITY_ANY = { min: 0, max: 300 } as const;
/** intervals.icu's largest `limit` (a larger one is a 422). */
export const SEARCH_LIMIT = 100;
/** Rep counts match within this fraction of this session's count... */
export const REP_COUNT_TOLERANCE = 0.4;
/** ...and never closer than this many reps. */
export const MIN_REP_COUNT_TOLERANCE = 2;
/** A candidate's typical rep time must be within this fraction of this session's. */
export const REP_TIME_MATCH_TOLERANCE = 0.15;
/** Earlier candidates read in the one bulk request, newest first. */
export const SIMILAR_CANDIDATES_MAX = 20;
/** Matches returned, newest first. */
export const SIMILAR_SESSIONS_MAX = 5;

/** Median of a non-empty list (the mean of the two middle values for an even count). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Mean of `value` weighted by moving time, skipping nulls; null when none has one. */
function timeWeightedMean(
  reps: WorkRep[],
  value: (rep: WorkRep) => number | null,
): number | null {
  let sum = 0;
  let weight = 0;
  for (const rep of reps) {
    const v = value(rep);
    if (v == null) continue;
    sum += v * rep.movingTimeS;
    weight += rep.movingTimeS;
  }
  return weight > 0 ? sum / weight : null;
}

/**
 * Reps whose moving time is within {@link TYPICAL_REP_TOLERANCE} of the
 * median rep time, in rep order. An extra block (a cool-down read as a rep)
 * or a pyramid's long reps drop out. Fewer than 2 means no repeated rep
 * length.
 */
export function typicalReps(reps: WorkRep[]): WorkRep[] {
  if (reps.length === 0) return [];
  const typical = median(reps.map((rep) => rep.movingTimeS));
  return reps.filter(
    (rep) =>
      Math.abs(rep.movingTimeS - typical) <= TYPICAL_REP_TOLERANCE * typical,
  );
}

/**
 * How many reps a count may differ by:
 * max(MIN_REP_COUNT_TOLERANCE, round(count * REP_COUNT_TOLERANCE)).
 * 2 → 2, 5 → 2, 10 → 4, 20 → 8. The issue proposed ±1, but a 3 x 1 mile
 * session is the same workout as 5 x 1 mile for progress.
 */
export function repCountTolerance(count: number): number {
  return Math.max(
    MIN_REP_COUNT_TOLERANCE,
    Math.round(count * REP_COUNT_TOLERANCE),
  );
}

export interface SimilarSearchBand extends IntervalsIntervalSearchQuery {
  /** False when a typical rep has no intensity, so the band is 0-300. */
  intensityUsed: boolean;
}

/**
 * The interval-search band for these typical reps (2 or more):
 * - minSecs = floor(shortest rep × (1 - SEARCH_SECONDS_MARGIN)),
 *   maxSecs = ceil(longest rep × (1 + SEARCH_SECONDS_MARGIN));
 * - when every rep has an intensity: its range widened by
 *   SEARCH_INTENSITY_MARGIN points (never below 0); else 0-300;
 * - minReps = max(2, n - tolerance), maxReps = n + tolerance;
 * - limit = SEARCH_LIMIT.
 */
export function similarSearchBand(typical: WorkRep[]): SimilarSearchBand {
  const times = typical.map((rep) => rep.movingTimeS);
  const intensities = typical.map((rep) => rep.intensityPct);
  const intensityUsed = intensities.every((value) => value != null);
  const known = intensities.filter((value): value is number => value != null);
  const count = typical.length;
  const tolerance = repCountTolerance(count);
  return {
    minSecs: Math.floor(Math.min(...times) * (1 - SEARCH_SECONDS_MARGIN)),
    maxSecs: Math.ceil(Math.max(...times) * (1 + SEARCH_SECONDS_MARGIN)),
    minIntensity: intensityUsed
      ? Math.max(0, Math.min(...known) - SEARCH_INTENSITY_MARGIN)
      : SEARCH_INTENSITY_ANY.min,
    maxIntensity: intensityUsed
      ? Math.max(...known) + SEARCH_INTENSITY_MARGIN
      : SEARCH_INTENSITY_ANY.max,
    minReps: Math.max(2, count - tolerance),
    maxReps: count + tolerance,
    limit: SEARCH_LIMIT,
    intensityUsed,
  };
}

export interface RepStructure {
  repCount: number;
  /** Median moving time of the typical reps, rounded s. */
  repTimeS: number;
  /** Median distance of the typical reps, rounded m. */
  repDistanceM: number;
  /** Total moving time over total distance, rounded s/km; null when distance is 0. */
  paceSecPerKm: number | null;
  /** Moving-time-weighted mean of the reps' avgHr, rounded; null when none has HR. */
  avgHr: number | null;
  /** Moving-time-weighted mean of the reps' intensityPct, rounded; null when none has one. */
  intensityPct: number | null;
  /** Last typical rep against the first, from `computeFade`; positive = slower. */
  paceDriftPct: number | null;
  hrDriftBpm: number | null;
}

/** Summary of typical reps (2 or more). */
export function summariseTypicalReps(typical: WorkRep[]): RepStructure {
  const totalTime = typical.reduce((sum, rep) => sum + rep.movingTimeS, 0);
  const totalDistance = typical.reduce((sum, rep) => sum + rep.distanceM, 0);
  const avgHr = timeWeightedMean(typical, (rep) => rep.avgHr);
  const intensity = timeWeightedMean(typical, (rep) => rep.intensityPct);
  const fade = computeFade(typical);
  return {
    repCount: typical.length,
    repTimeS: Math.round(median(typical.map((rep) => rep.movingTimeS))),
    repDistanceM: Math.round(median(typical.map((rep) => rep.distanceM))),
    paceSecPerKm:
      totalDistance > 0 ? Math.round((totalTime / totalDistance) * 1000) : null,
    avgHr: avgHr != null ? Math.round(avgHr) : null,
    intensityPct: intensity != null ? Math.round(intensity) : null,
    paceDriftPct: fade?.paceDriftPct ?? null,
    hrDriftBpm: fade?.hrDriftBpm ?? null,
  };
}

/**
 * Same structure: the typical rep time within REP_TIME_MATCH_TOLERANCE of
 * the source's, and the typical rep count within its tolerance. Intensity is
 * not compared here: the search already filtered on it, and heart-rate
 * intensity moves with heat and fatigue.
 */
export function sameRepStructure(
  candidate: RepStructure,
  source: RepStructure,
): boolean {
  return (
    Math.abs(candidate.repTimeS - source.repTimeS) <=
      REP_TIME_MATCH_TOLERANCE * source.repTimeS &&
    Math.abs(candidate.repCount - source.repCount) <=
      repCountTolerance(source.repCount)
  );
}

/** Run, TrailRun and VirtualRun count as one sport; any other type matches only itself. */
export function sameSportFamily(
  sourceType: string,
  candidateType: string | null | undefined,
): boolean {
  if (candidateType == null) return false;
  if (PACE_ACTIVITY_TYPES.has(sourceType)) {
    return PACE_ACTIVITY_TYPES.has(candidateType);
  }
  return candidateType === sourceType;
}

/**
 * Search rows that can be similar earlier sessions, in the given (newest
 * first) order: not the source, started before it (`start_date_local`
 * compared as text, both local ISO), and the same sport family. Counts what
 * it dropped; the source row itself is dropped and not counted.
 */
export function pickCandidates<
  T extends { id: string; start_date_local: string; type?: string | null },
>(
  rows: T[],
  source: { id: string; startDateLocal: string; type: string },
): { candidates: T[]; later: number; otherSport: number } {
  const candidates: T[] = [];
  let later = 0;
  let otherSport = 0;
  for (const row of rows) {
    if (row.id === source.id) continue;
    if (row.start_date_local >= source.startDateLocal) later++;
    else if (!sameSportFamily(source.type, row.type)) otherSport++;
    else candidates.push(row);
  }
  return { candidates, later, otherSport };
}
