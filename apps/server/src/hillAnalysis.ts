/**
 * Hill/grade performance math for `get-hill-analysis`. Pure functions
 * over the intervals.icu stream adapter's named arrays
 * (`intervalsStreams.ts`), unit-tested next to `trainingLoad.ts`.
 *
 * Detects sustained climbs and descents from the distance + grade streams,
 * summarises each (grade, pace, grade-adjusted pace, HR, cadence, power),
 * and reports the headline late-race question: did climbing cost more late
 * in the run than early? Effort is normalised as HR per unit of
 * grade-adjusted speed, so a slower-but-easier late climb is not misread as
 * fade. Altitude comes from intervals.icu's elevation stream.
 */

/**
 * Streams as returned by `loadIntervalsStreams`, index-aligned. Every
 * optional array is per-sample nullable (a gap in the recording, not a
 * missing stream). `distance` and `altitude` drive the index-based windowing
 * below and are interpolated across nulls by {@link normalizeHillStreams};
 * everything else keeps a null sample as "no data for this sample" and is
 * simply excluded from whatever it would have fed, never coerced to 0.
 */
export interface HillStreams {
  /** Seconds since activity start, non-decreasing. */
  time: number[];
  /** Cumulative metres. Required. */
  distance: (number | null)[];
  /** Elevation in metres. */
  altitude?: (number | null)[];
  /** intervals.icu's smoothed grade in percent, preferred when present. */
  grade_smooth?: (number | null)[];
  heartrate?: (number | null)[];
  /** Smoothed speed in m/s. */
  velocity_smooth?: (number | null)[];
  watts?: (number | null)[];
  /** Run cadence in strides-per-minute (one leg, as intervals.icu records it). */
  cadence?: (number | null)[];
  /** Derived stopped/moving flag; false = stopped. */
  moving?: boolean[];
}

/** Raised for inputs the analysis cannot work with; message is user-facing. */
export class HillAnalysisError extends Error {}

// Tunable detection constants: a climb is sustained grade ≥ 2%
// over ≥ 200 m, tolerant of brief dips.
/** Grade (%) that opens a candidate climb. */
export const CLIMB_MIN_GRADE_PCT = 2;
/** Grade (%) that keeps a climb alive once opened. */
export const CLIMB_CONTINUE_GRADE_PCT = 1;
/** Metres below the continue-grade allowed before a climb is closed. */
export const CLIMB_GRACE_DISTANCE_M = 150;
/** Minimum climb length in metres. */
export const CLIMB_MIN_LENGTH_M = 200;
/** Minimum average grade (%) for a validated climb. */
export const CLIMB_MIN_AVG_GRADE_PCT = 2;
/** Window (m) for deriving grade from altitude when grade_smooth is absent. */
export const GRADE_WINDOW_M = 30;
/**
 * Centred window (m) that grade is averaged over before {@link gapFactor}
 * sees it. The Minetti curve is convex, so zero-mean grade noise applied
 * sample by sample still raises the mean factor (±10% noise made flat GAP
 * 13% too fast); averaging over 100 m cancels the noise and keeps a real
 * climb's grade.
 */
export const GAP_GRADE_WINDOW_M = 100;
/**
 * Averaged grade (%) beyond which the GAP factor stops growing. Steeper than
 * this over 100 m is walking or scrambling, where a running cost model does
 * not hold.
 */
export const GAP_MAX_GRADE_PCT = 30;
/**
 * Distance-weighted RMS (percentage points) of per-sample grade around its
 * {@link GAP_GRADE_WINDOW_M} average above which the elevation track counts
 * as noisy. Real terrain changes grade over more than 100 m, so on a clean
 * track the residual stays small; barometric noise swings grade sample to
 * sample.
 */
export const NOISY_GRADE_RMS_PCT = 3;
/** Sample gaps longer than this contribute only this much weight. */
export const MAX_SAMPLE_GAP_SECONDS = 10;
/**
 * Minimum fraction of a segment's moving time that must carry a real
 * (non-zero) power sample before an average is reported. Below this, the
 * power stream is too gappy to summarise and the field is omitted.
 */
export const POWER_COVERAGE_MIN = 0.7;

export interface HillSegment {
  /** Kilometre mark where the segment starts. */
  startKm: number;
  endKm: number;
  lengthM: number;
  /** Altitude change start→end (positive on climbs, negative on descents). */
  elevationChangeM: number;
  avgGradePct: number;
  movingTimeS: number;
  /** Moving pace in seconds per km. */
  paceSecPerKm: number | null;
  /** Grade-adjusted (flat-equivalent) pace in seconds per km. */
  gapPaceSecPerKm: number | null;
  avgHr: number | null;
  /** Raw stream cadence (one-leg spm for runs; the tool doubles for display). */
  avgCadence: number | null;
  avgWatts: number | null;
  /** HR per m/s of grade-adjusted speed — the normalised climb cost. */
  hrPerGapSpeed: number | null;
}

export interface HillDrift {
  /** hr_per_gap when HR is available on both halves, gap_pace otherwise. */
  basis: "hr_per_gap" | "gap_pace";
  /** Duration-weighted mean cost over early / late climbs. */
  earlyValue: number;
  lateValue: number;
  /** % change late vs early; positive = climbing cost more late. */
  driftPct: number;
  earlyClimbs: number;
  lateClimbs: number;
}

/** Where the per-sample grade came from: intervals.icu's own stream, or derived from altitude. */
export type GradeSource = "grade_smooth" | "computed";

export interface HillAnalysis {
  climbs: HillSegment[];
  descents: HillSegment[];
  drift: HillDrift | null;
  gradeSource: GradeSource;
  totals: {
    climbCount: number;
    descentCount: number;
    climbDistanceM: number;
    climbGainM: number;
  };
  warnings: string[];
}

/**
 * Minetti et al. metabolic cost of gradient running, normalised to flat
 * (cost(0) = 3.6 J/kg/m). Multiplying speed by this factor yields the
 * flat-equivalent (GAP) speed. Gradient is clamped to ±35% where the
 * polynomial is well-behaved. Callers pass grade from {@link gapGrades},
 * never a raw per-sample grade (see {@link GAP_GRADE_WINDOW_M}).
 */
export function gapFactor(gradeFraction: number): number {
  const i = Math.max(-0.35, Math.min(0.35, gradeFraction));
  const cost =
    155.4 * i ** 5 -
    30.4 * i ** 4 -
    43.3 * i ** 3 +
    46.3 * i ** 2 +
    19.5 * i +
    3.6;
  return cost / 3.6;
}

/**
 * Linearly interpolates null samples in a stream that index-based math below
 * depends on staying fully populated (distance, altitude, grade): a null run
 * bounded by two known samples gets the straight-line value between them; a
 * leading or trailing run of nulls holds the nearest known value flat (there
 * is nothing to interpolate against). Never coerces a gap to 0: a missing
 * altitude sample is not sea level. A stream where "no data here" should stay
 * absent instead of being filled in (heart rate, cadence, velocity) is left
 * alone and its null samples are skipped where they are consumed, not routed
 * through this function.
 *
 * A stream with no real sample at all (intervals.icu's `allNull`) is an
 * absent stream, not a gap: callers drop it first ({@link hasRealSample}).
 * Given one, this throws rather than invent a value for every sample.
 */
export function interpolateNulls(values: (number | null)[]): number[] {
  if (values.length > 0 && !hasRealSample(values)) {
    throw new RangeError(
      "The stream has no recorded samples to interpolate between.",
    );
  }
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < values.length) {
    const v = values[i];
    if (v != null) {
      out[i] = v;
      i++;
      continue;
    }
    let j = i;
    while (j < values.length && values[j] == null) j++;
    const prev = i > 0 ? out[i - 1] : undefined;
    const next = j < values.length ? (values[j] as number) : undefined;
    const span = j - (i - 1);
    for (let k = i; k < j; k++) {
      if (prev != null && next != null) {
        out[k] = prev + ((next - prev) * (k - (i - 1))) / span;
      } else {
        // At least one side is known: the all-null case threw above.
        out[k] = (prev ?? next) as number;
      }
    }
    i = j;
  }
  return out;
}

/** True when the stream holds at least one recorded (non-null) sample. */
export function hasRealSample(values: (number | null)[] | undefined): boolean {
  return values?.some((v) => v != null) ?? false;
}

/**
 * `HillStreams` with distance/altitude/grade_smooth resolved to plain,
 * fully-populated numeric arrays (nulls interpolated, see
 * {@link interpolateNulls}) so every downstream function below can index
 * them without a null check. `altitude` and `grade_smooth` are each dropped
 * entirely (treated as absent) when the raw stream has no length match or is
 * entirely null, so {@link computeGrades} falls back exactly as it would for
 * a genuinely missing stream: an all-null altitude is no elevation data, not
 * flat terrain. Every other stream is passed through unchanged: a null
 * sample there means "no data for this sample", which the functions below
 * already skip rather than treat as 0.
 */
export interface NormalizedHillStreams {
  time: number[];
  distance: number[];
  altitude?: number[];
  grade_smooth?: number[];
  heartrate?: (number | null)[];
  velocity_smooth?: (number | null)[];
  watts?: (number | null)[];
  cadence?: (number | null)[];
  moving?: boolean[];
}

/**
 * Resolves nulls in `distance`/`altitude`/`grade_smooth`; see
 * {@link NormalizedHillStreams}. `distance` must hold a real sample (callers
 * check with {@link hasRealSample} and raise their own error first).
 */
export function normalizeHillStreams(
  streams: HillStreams,
): NormalizedHillStreams {
  const usable = (
    values: (number | null)[] | undefined,
  ): values is (number | null)[] =>
    values != null &&
    values.length === streams.distance.length &&
    hasRealSample(values);

  return {
    time: streams.time,
    distance: interpolateNulls(streams.distance),
    altitude: usable(streams.altitude)
      ? interpolateNulls(streams.altitude)
      : undefined,
    grade_smooth: usable(streams.grade_smooth)
      ? interpolateNulls(streams.grade_smooth)
      : undefined,
    heartrate: streams.heartrate,
    velocity_smooth: streams.velocity_smooth,
    watts: streams.watts,
    cadence: streams.cadence,
    moving: streams.moving,
  };
}

/**
 * Per-sample grade in percent: intervals.icu's grade_smooth when present,
 * otherwise altitude change over a trailing ~GRADE_WINDOW_M window
 * (single-sample altitude noise otherwise produces phantom micro-climbs).
 * Reports which source it used so callers can say so.
 */
export function computeGrades(
  streams: Pick<
    NormalizedHillStreams,
    "distance" | "altitude" | "grade_smooth"
  >,
): { grades: number[]; source: GradeSource } {
  const { distance, altitude, grade_smooth } = streams;
  if (grade_smooth) {
    return { grades: grade_smooth, source: "grade_smooth" };
  }
  if (!altitude || altitude.length !== distance.length) {
    throw new HillAnalysisError(
      "Neither a grade nor an altitude stream is available: hill analysis needs elevation data.",
    );
  }
  const grades = new Array<number>(distance.length).fill(0);
  let j = 0;
  for (let i = 1; i < distance.length; i++) {
    while (distance[i]! - distance[j + 1]! >= GRADE_WINDOW_M) j++;
    const run = distance[i]! - distance[j]!;
    grades[i] = run > 0 ? ((altitude[i]! - altitude[j]!) / run) * 100 : 0;
  }
  return { grades, source: "computed" };
}

/** Grade prepared for {@link gapFactor}, plus how noisy the raw grade was. */
export interface GapGrades {
  /** Per-sample grade (%) averaged over {@link GAP_GRADE_WINDOW_M}, clamped. */
  grades: number[];
  /** Distance-weighted RMS of the raw grade around that average (points). */
  noiseRmsPct: number;
  /** Set when {@link noiseRmsPct} exceeds {@link NOISY_GRADE_RMS_PCT}. */
  warning: string | null;
}

/**
 * The one grade every GAP number in this server is computed from: each
 * sample's grade is the distance-weighted mean over a centred
 * {@link GAP_GRADE_WINDOW_M} window (cut short at the ends of the
 * activity), clamped to ±{@link GAP_MAX_GRADE_PCT}. A steady climb keeps its
 * grade; zero-mean noise averages out instead of biasing GAP fast. The
 * residual of the raw grade around that mean measures how noisy the
 * elevation track is, and a noisy one gets a warning.
 */
export function gapGrades(grades: number[], distance: number[]): GapGrades {
  const n = grades.length;
  // rise[i] = grade × metres summed to sample i (sample i's grade covers
  // the interval that ends at it), so the mean over any distance span is a
  // difference of two interpolated values.
  const rise = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dd = Math.max(0, distance[i]! - distance[i - 1]!);
    rise[i] = rise[i - 1]! + grades[i]! * dd;
  }
  /** Rise at distance `d`, where `j` is the last sample at or before it. */
  const riseAt = (d: number, j: number) =>
    j >= n - 1
      ? rise[n - 1]!
      : rise[j]! + grades[j + 1]! * Math.max(0, d - distance[j]!);

  const first = distance[0] ?? 0;
  const last = distance[n - 1] ?? 0;
  const half = GAP_GRADE_WINDOW_M / 2;
  const out = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  let squares = 0;
  let weight = 0;
  for (let i = 0; i < n; i++) {
    const from = Math.max(first, distance[i]! - half);
    const to = Math.min(last, distance[i]! + half);
    while (lo < n - 1 && distance[lo + 1]! <= from) lo++;
    while (hi < n - 1 && distance[hi + 1]! <= to) hi++;
    const mean =
      to > from
        ? (riseAt(to, hi) - riseAt(from, lo)) / (to - from)
        : grades[i]!;
    out[i] = Math.max(-GAP_MAX_GRADE_PCT, Math.min(GAP_MAX_GRADE_PCT, mean));
    const dd = i > 0 ? distance[i]! - distance[i - 1]! : 0;
    if (dd > 0) {
      squares += (grades[i]! - mean) ** 2 * dd;
      weight += dd;
    }
  }

  const noiseRmsPct = weight > 0 ? Math.sqrt(squares / weight) : 0;
  return {
    grades: out,
    noiseRmsPct,
    warning:
      noiseRmsPct > NOISY_GRADE_RMS_PCT
        ? `The elevation track is noisy: grade swings about ±${round(noiseRmsPct, 1)}% around its ${GAP_GRADE_WINDOW_M} m average from sample to sample. Grade-adjusted pace uses grade averaged over ${GAP_GRADE_WINDOW_M} m, but read it as approximate.`
        : null,
  };
}

/**
 * Per-sample grade-adjusted speed (m/s) for a caller that needs a GAP stream
 * rather than segment averages (`get-aerobic-analysis`): `velocity_smooth`
 * times {@link gapFactor} of {@link gapGrades}' averaged grade, the same GAP
 * the hill and split tools report. Null without a distance stream, a speed
 * stream, or any elevation data; a null speed sample stays null.
 */
export function gradeAdjustedSpeeds(
  streams: Pick<
    HillStreams,
    "time" | "distance" | "altitude" | "grade_smooth" | "velocity_smooth"
  >,
): {
  speeds: (number | null)[];
  gradeSource: GradeSource;
  warning: string | null;
} | null {
  const velocity = streams.velocity_smooth;
  if (!velocity || !hasRealSample(streams.distance)) return null;
  const normalized = normalizeHillStreams(streams);
  if (!normalized.altitude && !normalized.grade_smooth) return null;
  const { grades, source } = computeGrades(normalized);
  const gap = gapGrades(grades, normalized.distance);
  return {
    speeds: velocity.map((v, i) =>
      v == null ? null : v * gapFactor(gap.grades[i]! / 100),
    ),
    gradeSource: source,
    warning: gap.warning,
  };
}

interface IndexRange {
  start: number;
  end: number;
}

/**
 * Sustained-grade detection: a segment opens when signed grade reaches
 * CLIMB_MIN_GRADE_PCT, stays alive while it holds CLIMB_CONTINUE_GRADE_PCT,
 * tolerates dips shorter than CLIMB_GRACE_DISTANCE_M, and validates on
 * length and average grade. `sign` +1 finds climbs, −1 descents.
 */
export function detectSustained(
  grades: number[],
  distance: number[],
  altitude: number[] | undefined,
  sign: 1 | -1,
): IndexRange[] {
  const ranges: IndexRange[] = [];
  let start = -1;
  let lastStrong = -1;

  const close = () => {
    if (start < 0 || lastStrong <= start) return;
    const lengthM = distance[lastStrong]! - distance[start]!;
    const avgGrade = altitude
      ? ((altitude[lastStrong]! - altitude[start]!) / lengthM) * 100 * sign
      : averageGrade(grades, distance, start, lastStrong) * sign;
    if (lengthM >= CLIMB_MIN_LENGTH_M && avgGrade >= CLIMB_MIN_AVG_GRADE_PCT) {
      ranges.push({ start, end: lastStrong });
    }
    start = -1;
    lastStrong = -1;
  };

  for (let i = 0; i < grades.length; i++) {
    const g = grades[i]! * sign;
    if (start < 0) {
      if (g >= CLIMB_MIN_GRADE_PCT) {
        start = Math.max(0, i - 1);
        lastStrong = i;
      }
      continue;
    }
    if (g >= CLIMB_CONTINUE_GRADE_PCT) {
      lastStrong = i;
    } else if (distance[i]! - distance[lastStrong]! > CLIMB_GRACE_DISTANCE_M) {
      close();
    }
  }
  close();
  return ranges;
}

function averageGrade(
  grades: number[],
  distance: number[],
  start: number,
  end: number,
): number {
  let sum = 0;
  let weight = 0;
  for (let i = start + 1; i <= end; i++) {
    const dd = distance[i]! - distance[i - 1]!;
    if (dd <= 0) continue;
    sum += grades[i]! * dd;
    weight += dd;
  }
  return weight > 0 ? sum / weight : 0;
}

const round = (value: number, dp = 2) =>
  Math.round(value * 10 ** dp) / 10 ** dp;

/**
 * `grades` is the detection grade (drives the average when there is no
 * altitude); `gapGrade` is {@link gapGrades}' averaged grade for GAP.
 */
function summarizeSegment(
  streams: NormalizedHillStreams,
  grades: number[],
  gapGrade: number[],
  range: IndexRange,
): HillSegment {
  const { time, distance, altitude, heartrate, velocity_smooth, watts } =
    streams;
  const cadence = streams.cadence;
  const moving = streams.moving;
  const { start, end } = range;
  const lengthM = distance[end]! - distance[start]!;

  let movingTimeS = 0;
  let hrSum = 0;
  let hrW = 0;
  let cadSum = 0;
  let cadW = 0;
  let wattsSum = 0;
  let wattsW = 0;
  let gapSpeedSum = 0;
  let gapW = 0;

  for (let i = start + 1; i <= end; i++) {
    const dt = time[i]! - time[i - 1]!;
    if (dt <= 0) continue;
    if (moving && moving[i] === false) continue;
    const weight = Math.min(dt, MAX_SAMPLE_GAP_SECONDS);
    movingTimeS += weight;

    const hr = heartrate?.[i];
    if (hr != null && hr > 0) {
      hrSum += hr * weight;
      hrW += weight;
    }
    const cad = cadence?.[i];
    if (cad != null && cad > 0) {
      cadSum += cad * weight;
      cadW += weight;
    }
    // Run power of exactly 0 while moving is a stream dropout, not a real
    // observation; including it drags the average toward zero.
    const w = watts?.[i];
    if (w != null && w > 0) {
      wattsSum += w * weight;
      wattsW += weight;
    }
    const v = velocity_smooth?.[i] ?? (distance[i]! - distance[i - 1]!) / dt;
    if (v != null && v > 0) {
      gapSpeedSum += v * gapFactor(gapGrade[i]! / 100) * weight;
      gapW += weight;
    }
  }

  const gapSpeed = gapW > 0 ? gapSpeedSum / gapW : 0;
  const avgHr = hrW > 0 ? hrSum / hrW : null;
  const paceSecPerKm =
    movingTimeS > 0 && lengthM > 0 ? movingTimeS / (lengthM / 1000) : null;

  return {
    startKm: round(distance[start]! / 1000),
    endKm: round(distance[end]! / 1000),
    lengthM: Math.round(lengthM),
    elevationChangeM: altitude
      ? round(altitude[end]! - altitude[start]!, 1)
      : round((averageGrade(grades, distance, start, end) / 100) * lengthM, 1),
    avgGradePct: round(
      altitude && lengthM > 0
        ? ((altitude[end]! - altitude[start]!) / lengthM) * 100
        : averageGrade(grades, distance, start, end),
      1,
    ),
    movingTimeS: Math.round(movingTimeS),
    paceSecPerKm: paceSecPerKm != null ? Math.round(paceSecPerKm) : null,
    gapPaceSecPerKm: gapSpeed > 0 ? Math.round(1000 / gapSpeed) : null,
    avgHr: avgHr != null ? round(avgHr, 0) : null,
    avgCadence: cadW > 0 ? round(cadSum / cadW, 1) : null,
    // Omit power when coverage is too thin to be meaningful — a segment sitting
    // in a power-stream gap should report no power, not a skewed one.
    avgWatts:
      wattsW > 0 &&
      movingTimeS > 0 &&
      wattsW / movingTimeS >= POWER_COVERAGE_MIN
        ? round(wattsSum / wattsW, 0)
        : null,
    hrPerGapSpeed:
      avgHr != null && gapSpeed > 0 ? round(avgHr / gapSpeed, 2) : null,
  };
}

/**
 * Late-vs-early climb drift. Climbs are split by their start point relative
 * to the run's midpoint; each half's cost is the duration-weighted mean of
 * HR per grade-adjusted speed (or plain GAP pace when HR is missing).
 * Positive drift = climbing cost more late in the run.
 */
export function computeDrift(
  climbs: HillSegment[],
  totalDistanceM: number,
): HillDrift | null {
  const midKm = totalDistanceM / 2000;
  const early = climbs.filter((c) => c.startKm < midKm);
  const late = climbs.filter((c) => c.startKm >= midKm);
  if (early.length === 0 || late.length === 0) return null;

  const hrUsable = (c: HillSegment) => c.hrPerGapSpeed != null;
  const useHr = early.some(hrUsable) && late.some(hrUsable);

  const value = (group: HillSegment[]): number | null => {
    let sum = 0;
    let weight = 0;
    for (const c of group) {
      const v = useHr ? c.hrPerGapSpeed : c.gapPaceSecPerKm;
      if (v == null) continue;
      sum += v * c.movingTimeS;
      weight += c.movingTimeS;
    }
    return weight > 0 ? sum / weight : null;
  };

  const earlyValue = value(early);
  const lateValue = value(late);
  if (earlyValue == null || lateValue == null || earlyValue <= 0) return null;

  return {
    basis: useHr ? "hr_per_gap" : "gap_pace",
    earlyValue: round(earlyValue),
    lateValue: round(lateValue),
    driftPct: round(((lateValue - earlyValue) / earlyValue) * 100, 1),
    earlyClimbs: early.length,
    lateClimbs: late.length,
  };
}

export function computeHillAnalysis(streams: HillStreams): HillAnalysis {
  if (
    !streams.distance ||
    streams.distance.length < 2 ||
    !hasRealSample(streams.distance)
  ) {
    throw new HillAnalysisError(
      "No distance stream is available: hill analysis needs distance and elevation data.",
    );
  }
  if (streams.time.length !== streams.distance.length) {
    throw new HillAnalysisError(
      "The time and distance streams are misaligned.",
    );
  }

  const normalized = normalizeHillStreams(streams);
  const warnings: string[] = [];
  const { grades, source: gradeSource } = computeGrades(normalized);
  if (gradeSource === "computed") {
    warnings.push(
      "No smoothed-grade stream; grade was derived from altitude over ~30 m windows.",
    );
  }
  const gap = gapGrades(grades, normalized.distance);
  if (gap.warning) warnings.push(gap.warning);
  if (!normalized.heartrate) {
    warnings.push(
      "No heart rate stream; climb drift falls back to grade-adjusted pace only.",
    );
  }

  const climbRanges = detectSustained(
    grades,
    normalized.distance,
    normalized.altitude,
    1,
  );
  const descentRanges = detectSustained(
    grades,
    normalized.distance,
    normalized.altitude,
    -1,
  );

  const climbs = climbRanges.map((r) =>
    summarizeSegment(normalized, grades, gap.grades, r),
  );
  const descents = descentRanges.map((r) =>
    summarizeSegment(normalized, grades, gap.grades, r),
  );

  const totalDistanceM = normalized.distance[normalized.distance.length - 1]!;
  const drift = computeDrift(climbs, totalDistanceM);
  if (climbs.length === 0) {
    warnings.push(
      "No sustained climbs detected (grade ≥ 2% for ≥ 200 m): this looks like a flat activity.",
    );
  } else if (drift == null) {
    warnings.push(
      "Not enough climbs on both halves of the run to compute early-vs-late drift.",
    );
  }

  return {
    climbs,
    descents,
    drift,
    gradeSource,
    totals: {
      climbCount: climbs.length,
      descentCount: descents.length,
      climbDistanceM: climbs.reduce((sum, c) => sum + c.lengthM, 0),
      climbGainM: round(
        climbs.reduce((sum, c) => sum + Math.max(0, c.elevationChangeM), 0),
        1,
      ),
    },
    warnings,
  };
}
