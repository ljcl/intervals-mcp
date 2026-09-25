/**
 * Even-split math for `get-split-analysis`. Pure functions over the
 * intervals.icu stream adapter's named arrays (`intervalsStreams.ts`),
 * unit-tested next to `hillAnalysis.ts`. Splits are kilometres only.
 *
 * Answers the most common post-run question — "did I positive-split this, and
 * how much of the slowdown was just the hills?" — by binning the streams into
 * fixed-km splits and comparing the two halves twice: once on the clock,
 * once on grade-adjusted pace. A hilly back half slows raw pace without any
 * fade, and a course that flattens out hides fade; reporting both is what
 * separates the two.
 *
 * Grade handling, null-sample handling, and the Minetti GAP factor are
 * `hillAnalysis.ts`'s (`computeGrades`, `normalizeHillStreams`, `gapFactor`):
 * there is one definition of grade-adjusted pace in this server, and the
 * climb tool and this one share it.
 */

import {
  computeGrades,
  type GradeSource,
  gapFactor,
  type HillStreams,
  MAX_SAMPLE_GAP_SECONDS,
  type NormalizedHillStreams,
  normalizeHillStreams,
  POWER_COVERAGE_MIN,
} from "./hillAnalysis";

/** Streams as returned by the intervals.icu stream adapter. Same shape the climbs use. */
export type SplitStreams = HillStreams;

/** Raised for inputs the analysis cannot work with; message is user-facing. */
export class SplitAnalysisError extends Error {}

/** Metres per split (kilometres only). */
export const SPLIT_LENGTH_M = 1000;

/**
 * Half-to-half pace change (%) inside which a run counts as evenly paced.
 * Wide enough to absorb GPS distance noise and a single traffic light, narrow
 * enough that a real fade still reads as one.
 */
export const EVEN_SPLIT_PCT = 2;

/** Minimum moving seconds per half before a verdict is worth stating. */
export const MIN_HALF_MOVING_SECONDS = 120;

/**
 * Fraction of a km below which a trailing remainder is folded into the
 * previous split instead of becoming one. A GPS track ending at 5000.4 m would
 * otherwise produce a 40 cm "split" whose extrapolated pace is meaningless.
 */
export const MIN_TRAILING_SPLIT_FRACTION = 0.05;

export type SplitShape = "even" | "positive" | "negative";

export interface Split {
  /** 1-based split number. */
  index: number;
  /** Cumulative metres at the split's start and end. */
  startM: number;
  endM: number;
  /** Metres actually covered — short on a trailing partial split. */
  distanceM: number;
  /** True when the split is shorter than a full km (the run ended). */
  partial: boolean;
  movingTimeS: number;
  elapsedTimeS: number;
  /** Moving pace in seconds per km (extrapolated on a partial split). */
  paceSecPerKm: number | null;
  /** Grade-adjusted (flat-equivalent) pace in seconds per km. */
  gapPaceSecPerKm: number | null;
  elevationChangeM: number | null;
  avgGradePct: number | null;
  avgHr: number | null;
  /** Raw stream cadence (one-leg spm for runs; the tool doubles for display). */
  avgCadence: number | null;
  avgWatts: number | null;
}

export interface SplitVerdict {
  /** Shape on the clock: positive = second half slower. */
  shape: SplitShape;
  /** Shape once grade is corrected for — the terrain-free read. */
  gapShape: SplitShape;
  firstHalfPaceSecPerKm: number;
  secondHalfPaceSecPerKm: number;
  firstHalfGapPaceSecPerKm: number | null;
  secondHalfGapPaceSecPerKm: number | null;
  /** % pace change, second half vs first. Positive = slower. */
  deltaPct: number;
  /** Same, grade-adjusted. Null without usable grade data. */
  gapDeltaPct: number | null;
  /**
   * Percentage points of `deltaPct` the terrain accounts for
   * (`deltaPct − gapDeltaPct`). Positive = the back half was hillier.
   */
  terrainPct: number | null;
  /** Net altitude change over each half — the terrain the pace was run on. */
  firstHalfElevationChangeM: number | null;
  secondHalfElevationChangeM: number | null;
  interpretation: string;
}

export interface SplitAnalysis {
  splits: Split[];
  verdict: SplitVerdict | null;
  gradeSource: GradeSource;
  fastestSplitIndex: number | null;
  slowestSplitIndex: number | null;
  totals: {
    distanceM: number;
    movingTimeS: number;
    elapsedTimeS: number;
    elevationGainM: number;
    avgPaceSecPerKm: number | null;
    avgGapPaceSecPerKm: number | null;
  };
  warnings: string[];
}

const round = (value: number, dp = 2) =>
  Math.round(value * 10 ** dp) / 10 ** dp;

/** Running accumulator for one distance bucket. */
export interface Bin {
  startM: number;
  endM: number;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  hrSum: number;
  hrW: number;
  cadSum: number;
  cadW: number;
  wattsSum: number;
  wattsW: number;
  gapSpeedSum: number;
  gapW: number;
  startAlt: number | null;
  endAlt: number | null;
}

function emptyBin(startM: number, endM: number): Bin {
  return {
    startM,
    endM,
    distanceM: 0,
    movingTimeS: 0,
    elapsedTimeS: 0,
    hrSum: 0,
    hrW: 0,
    cadSum: 0,
    cadW: 0,
    wattsSum: 0,
    wattsW: 0,
    gapSpeedSum: 0,
    gapW: 0,
    startAlt: null,
    endAlt: null,
  };
}

/**
 * Accumulate the streams into buckets bounded by `edges` (cumulative metres,
 * ascending). A sample interval straddling a boundary is divided between the
 * buckets in proportion to the distance falling in each, so a coarse stream
 * does not dump a whole 40 m interval into whichever split it happened to end
 * in — and so the same core can bin per-km splits and exact halves alike.
 */
export function binByDistance(
  streams: NormalizedHillStreams,
  grades: number[],
  edges: number[],
): Bin[] {
  const bins: Bin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    bins.push(emptyBin(edges[i]!, edges[i + 1]!));
  }
  if (bins.length === 0) return bins;

  const { time, distance, altitude, heartrate, velocity_smooth, watts } =
    streams;
  const cadence = streams.cadence;
  const moving = streams.moving;
  const lastEdge = edges[edges.length - 1]!;

  /** Bucket a point at cumulative distance `d` belongs to. */
  const binAt = (d: number): Bin | undefined => {
    if (d >= lastEdge) return bins[bins.length - 1];
    for (const bin of bins) {
      if (d >= bin.startM && d < bin.endM) return bin;
    }
    return undefined;
  };

  const observeAltitude = (bin: Bin, alt: number | undefined) => {
    if (alt == null) return;
    if (bin.startAlt === null) bin.startAlt = alt;
    bin.endAlt = alt;
  };

  observeAltitude(binAt(distance[0]!) ?? bins[0]!, altitude?.[0]);

  for (let i = 1; i < distance.length; i++) {
    const dt = (time[i] ?? 0) - (time[i - 1] ?? 0);
    if (dt <= 0) continue;
    const d0 = distance[i - 1]!;
    const d1 = distance[i]!;
    const isMoving = !(moving && moving[i] === false);
    // Averages weight a long gap as MAX_SAMPLE_GAP_SECONDS, so a paused
    // recording cannot dominate the split it resumed in.
    const weight = Math.min(dt, MAX_SAMPLE_GAP_SECONDS);

    const dd = d1 - d0;
    if (dd <= 0) {
      // Standing still: time lands wholly in the bucket the athlete is in.
      const bin = binAt(d0);
      if (!bin) continue;
      bin.elapsedTimeS += dt;
      if (isMoving) bin.movingTimeS += dt;
      observeAltitude(bin, altitude?.[i]);
      continue;
    }

    const gapSpeedFactor = gapFactor((grades[i] ?? 0) / 100);
    const speed = velocity_smooth?.[i] ?? dd / dt;
    const hr = heartrate?.[i];
    const cad = cadence?.[i];
    // Run power of exactly 0 while moving is a stream dropout, not a real
    // observation; including it drags the average toward zero.
    const w = watts?.[i];

    for (const bin of bins) {
      const overlap =
        Math.min(d1, bin === bins[bins.length - 1] ? Infinity : bin.endM) -
        Math.max(d0, bin.startM);
      if (overlap <= 0) continue;
      const share = Math.min(overlap / dd, 1);

      bin.distanceM += dd * share;
      bin.elapsedTimeS += dt * share;
      if (!isMoving) continue;

      const binWeight = weight * share;
      bin.movingTimeS += dt * share;
      if (hr != null && hr > 0) {
        bin.hrSum += hr * binWeight;
        bin.hrW += binWeight;
      }
      if (cad != null && cad > 0) {
        bin.cadSum += cad * binWeight;
        bin.cadW += binWeight;
      }
      if (w != null && w > 0) {
        bin.wattsSum += w * binWeight;
        bin.wattsW += binWeight;
      }
      if (speed != null && speed > 0) {
        bin.gapSpeedSum += speed * gapSpeedFactor * binWeight;
        bin.gapW += binWeight;
      }
    }

    const endBin = binAt(d1);
    if (endBin) observeAltitude(endBin, altitude?.[i]);
  }

  return bins;
}

/** Seconds per km from a bin's moving time and distance. */
function paceFromBin(bin: Bin): number | null {
  if (bin.movingTimeS <= 0 || bin.distanceM <= 0) return null;
  return bin.movingTimeS / (bin.distanceM / SPLIT_LENGTH_M);
}

/** Grade-adjusted seconds per km from a bin's mean flat-equivalent speed. */
function gapPaceFromBin(bin: Bin): number | null {
  if (bin.gapW <= 0) return null;
  const gapSpeed = bin.gapSpeedSum / bin.gapW;
  return gapSpeed > 0 ? SPLIT_LENGTH_M / gapSpeed : null;
}

function shapeOf(deltaPct: number): SplitShape {
  if (deltaPct > EVEN_SPLIT_PCT) return "positive";
  if (deltaPct < -EVEN_SPLIT_PCT) return "negative";
  return "even";
}

const pct = (value: number) => `${Math.abs(round(value, 1))}%`;

/**
 * The sentence the whole tool exists for: what the clock says, what the
 * terrain explains, and what is left over as fade or as strength.
 */
export function interpretSplit(
  shape: SplitShape,
  gapShape: SplitShape,
  deltaPct: number,
  gapDeltaPct: number | null,
): string {
  if (gapDeltaPct === null) {
    const clock =
      shape === "positive"
        ? `Second half ${pct(deltaPct)} slower than the first: a positive split.`
        : shape === "negative"
          ? `Second half ${pct(deltaPct)} faster than the first: a negative split.`
          : `Halves within ${EVEN_SPLIT_PCT}% of each other: an even split.`;
    return `${clock} No elevation data, so none of this is corrected for terrain.`;
  }

  const terrainPct = deltaPct - gapDeltaPct;

  if (shape === "positive") {
    if (gapShape === "positive") {
      // Both slower, but the hills can still own part of it — saying "not
      // terrain" while reporting a terrain share of 4 points contradicts the
      // number right above it.
      return terrainPct >= EVEN_SPLIT_PCT
        ? `Second half ${pct(deltaPct)} slower on the clock; the terrain explains ${pct(terrainPct)} of that and the remaining ${pct(gapDeltaPct)} grade-adjusted is fade.`
        : `Second half ${pct(deltaPct)} slower on the clock and still ${pct(gapDeltaPct)} slower grade-adjusted: that is fade, not terrain.`;
    }
    if (gapShape === "even") {
      return `Second half ${pct(deltaPct)} slower on the clock, but grade-adjusted the halves are within ${EVEN_SPLIT_PCT}%: the slowdown was the terrain, not fade.`;
    }
    return `Second half ${pct(deltaPct)} slower on the clock yet ${pct(gapDeltaPct)} faster grade-adjusted: the back half was hillier and you pushed harder into it.`;
  }

  if (shape === "even") {
    if (gapShape === "negative") {
      return `Even split on the clock, ${pct(gapDeltaPct)} faster grade-adjusted: the back half was harder ground held at the same pace.`;
    }
    if (gapShape === "positive") {
      return `Even split on the clock, but ${pct(gapDeltaPct)} slower grade-adjusted: the back half was easier ground and it took the same pace to hold it.`;
    }
    return `Halves within ${EVEN_SPLIT_PCT}% of each other on the clock and grade-adjusted: evenly paced on even terrain.`;
  }

  if (gapShape === "negative") {
    return `Second half ${pct(deltaPct)} faster on the clock and ${pct(gapDeltaPct)} faster grade-adjusted: a real negative split.`;
  }
  if (gapShape === "even") {
    return `Second half ${pct(deltaPct)} faster on the clock, but grade-adjusted the halves are within ${EVEN_SPLIT_PCT}%: the back half was easier ground rather than a stronger finish.`;
  }
  return `Second half ${pct(deltaPct)} faster on the clock yet ${pct(gapDeltaPct)} slower grade-adjusted: a downhill finish, not a stronger one.`;
}

/** Bin a bucket's altitude change, when altitude was recorded. */
function elevationChange(bin: Bin): number | null {
  return bin.startAlt != null && bin.endAlt != null
    ? round(bin.endAlt - bin.startAlt, 1)
    : null;
}

/** Positive elevation change only, for a gain figure. */
function elevationGain(bins: Bin[]): number {
  let gain = 0;
  for (const bin of bins) {
    const change = elevationChange(bin);
    if (change != null && change > 0) gain += change;
  }
  return round(gain, 1);
}

/**
 * Fixed-km splits plus the two-halves verdict. Halves are binned at the
 * exact midpoint of recorded distance rather than by grouping splits, so an
 * odd split count or a short trailing split cannot skew the comparison.
 */
export function computeSplitAnalysis(streams: SplitStreams): SplitAnalysis {
  if (!streams.distance || streams.distance.length < 2 || !streams.time) {
    throw new SplitAnalysisError(
      "No distance and time streams are available: split analysis needs both.",
    );
  }

  const normalized = normalizeHillStreams(streams);
  const distance = normalized.distance;
  const totalM = distance[distance.length - 1]! - distance[0]!;
  if (totalM <= 0) {
    throw new SplitAnalysisError(
      "The activity covers no distance: there is nothing to split.",
    );
  }

  const warnings: string[] = [];
  // Grade comes from hillAnalysis (intervals.icu's grade_smooth, else an
  // altitude window). With neither, every sample is treated as flat: GAP
  // collapses onto raw pace, which the warning says outright rather than
  // letting an uncorrected verdict read as corrected.
  const hasElevation = Boolean(normalized.altitude || normalized.grade_smooth);
  const { grades, source: gradeSource } = hasElevation
    ? computeGrades(normalized)
    : {
        grades: new Array<number>(distance.length).fill(0),
        source: "computed" as const,
      };
  if (!hasElevation) {
    warnings.push(
      "No elevation or grade stream: grade-adjusted pace equals raw pace, so the terrain correction is unavailable.",
    );
  }

  const base = distance[0]!;
  const end = base + totalM;
  const splitEdges: number[] = [];
  for (let edge = base; edge < end; edge += SPLIT_LENGTH_M) {
    splitEdges.push(edge);
  }
  splitEdges.push(end);
  // Fold a sliver of a trailing split into the one before it.
  const trailing = end - splitEdges[splitEdges.length - 2]!;
  if (
    splitEdges.length > 2 &&
    trailing < SPLIT_LENGTH_M * MIN_TRAILING_SPLIT_FRACTION
  ) {
    splitEdges.splice(splitEdges.length - 2, 1);
  }

  const splitBins = binByDistance(normalized, grades, splitEdges);
  const splits: Split[] = splitBins.map((bin, i) => {
    const partial = bin.endM - bin.startM < SPLIT_LENGTH_M - 1;
    const change = elevationChange(bin);
    return {
      index: i + 1,
      startM: Math.round(bin.startM - base),
      endM: Math.round(bin.endM - base),
      distanceM: Math.round(bin.distanceM),
      partial,
      movingTimeS: Math.round(bin.movingTimeS),
      elapsedTimeS: Math.round(bin.elapsedTimeS),
      paceSecPerKm: roundOrNull(paceFromBin(bin)),
      gapPaceSecPerKm: roundOrNull(gapPaceFromBin(bin)),
      elevationChangeM: change,
      avgGradePct:
        change != null && bin.distanceM > 0
          ? round((change / bin.distanceM) * 100, 1)
          : null,
      avgHr: bin.hrW > 0 ? Math.round(bin.hrSum / bin.hrW) : null,
      avgCadence: bin.cadW > 0 ? round(bin.cadSum / bin.cadW, 1) : null,
      // Omit power when coverage is too thin to be meaningful.
      avgWatts:
        bin.wattsW > 0 &&
        bin.movingTimeS > 0 &&
        bin.wattsW / bin.movingTimeS >= POWER_COVERAGE_MIN
          ? Math.round(bin.wattsSum / bin.wattsW)
          : null,
    };
  });

  if (splits.length === 1 && splits[0]!.partial) {
    warnings.push(
      "The activity is shorter than one km; the single split covers the whole activity.",
    );
  }

  // Fastest/slowest ignore a partial split: its extrapolated pace is not
  // comparable to a full one over the same ground.
  const fullSplits = splits.filter((split) => !split.partial);
  const ranked = fullSplits
    .filter((split) => split.paceSecPerKm != null)
    .sort((a, b) => a.paceSecPerKm! - b.paceSecPerKm!);

  const totalBin = binByDistance(normalized, grades, [base, base + totalM])[0]!;
  const halfBins = binByDistance(normalized, grades, [
    base,
    base + totalM / 2,
    base + totalM,
  ]);

  return {
    splits,
    verdict: buildVerdict(halfBins, warnings),
    gradeSource,
    fastestSplitIndex: ranked[0]?.index ?? null,
    slowestSplitIndex: ranked[ranked.length - 1]?.index ?? null,
    totals: {
      distanceM: Math.round(totalM),
      movingTimeS: Math.round(totalBin.movingTimeS),
      elapsedTimeS: Math.round(totalBin.elapsedTimeS),
      elevationGainM: elevationGain(splitBins),
      avgPaceSecPerKm: roundOrNull(paceFromBin(totalBin)),
      avgGapPaceSecPerKm: roundOrNull(gapPaceFromBin(totalBin)),
    },
    warnings,
  };
}

function roundOrNull(value: number | null): number | null {
  return value == null ? null : Math.round(value);
}

function buildVerdict(
  halfBins: Bin[],
  warnings: string[],
): SplitVerdict | null {
  const [first, second] = halfBins;
  if (!first || !second) return null;

  const firstPace = paceFromBin(first);
  const secondPace = paceFromBin(second);
  if (firstPace == null || secondPace == null || firstPace <= 0) return null;

  if (
    first.movingTimeS < MIN_HALF_MOVING_SECONDS ||
    second.movingTimeS < MIN_HALF_MOVING_SECONDS
  ) {
    warnings.push(
      `Each half holds under ${Math.round(MIN_HALF_MOVING_SECONDS / 60)} minutes of moving time: too short for a pacing verdict to mean much.`,
    );
    return null;
  }

  const firstGap = gapPaceFromBin(first);
  const secondGap = gapPaceFromBin(second);
  const deltaPct = ((secondPace - firstPace) / firstPace) * 100;
  const gapDeltaPct =
    firstGap != null && secondGap != null && firstGap > 0
      ? ((secondGap - firstGap) / firstGap) * 100
      : null;

  const shape = shapeOf(deltaPct);
  const gapShape = gapDeltaPct == null ? shape : shapeOf(gapDeltaPct);

  return {
    shape,
    gapShape,
    firstHalfPaceSecPerKm: Math.round(firstPace),
    secondHalfPaceSecPerKm: Math.round(secondPace),
    firstHalfGapPaceSecPerKm: roundOrNull(firstGap),
    secondHalfGapPaceSecPerKm: roundOrNull(secondGap),
    deltaPct: round(deltaPct, 1),
    gapDeltaPct: gapDeltaPct == null ? null : round(gapDeltaPct, 1),
    terrainPct: gapDeltaPct == null ? null : round(deltaPct - gapDeltaPct, 1),
    firstHalfElevationChangeM: elevationChange(first),
    secondHalfElevationChangeM: elevationChange(second),
    interpretation: interpretSplit(shape, gapShape, deltaPct, gapDeltaPct),
  };
}
