/**
 * Aerobic decoupling and efficiency math for `get-aerobic-analysis`.
 * Pure functions over the intervals.icu stream adapter's named arrays
 * (`intervalsStreams.ts`), unit-tested next to `trainingLoad.ts`.
 *
 * Decoupling is the % drift in the output:HR ratio between the first and
 * second half of the *moving* portion of a run (Friel's Pw:Hr / Pa:Hr):
 * positive = the second half cost more heartbeats per watt (or per m/s) —
 * the aerobic system fading; negative = warmed into the run. Stopped time is
 * excluded before splitting halves so traffic lights and café stops cannot
 * poison the ratio.
 *
 * The basis (power vs. speed) is chosen by the caller, not auto-detected
 * here: `get-aerobic-analysis` decides which output stream to pass in based
 * on its `basis` input, so a `pace`-basis request never silently reads watts
 * and a `power`-basis request never silently falls back to speed.
 */

/**
 * Streams as returned by `loadIntervalsStreams` (`intervalsStreams.ts`),
 * index-aligned. `time` is required and non-null; every other stream is
 * per-sample nullable (a gap in the recording), which the functions below
 * already skip rather than coerce to 0. Pass only the output stream (`watts`
 * or `velocity_smooth`) matching the basis the caller wants analysed.
 */
export interface AerobicStreams {
  /** Seconds since activity start, non-decreasing. */
  time: number[];
  /** Beats per minute. Required for any analysis. */
  heartrate?: (number | null)[];
  /** Power in watts (power basis). */
  watts?: (number | null)[];
  /** Smoothed speed in m/s (speed/pace basis). */
  velocity_smooth?: (number | null)[];
  /** Derived moving flag per sample; false = stopped (traffic light, café). */
  moving?: boolean[];
}

export interface AerobicAnalysisOptions {
  /** Moving seconds to drop from the start before splitting halves. */
  excludeWarmupSeconds?: number;
  /** Threshold power for IF; typically the athlete's FTP. */
  thresholdPower?: number | null;
}

export interface HalfSummary {
  /** Duration-weighted mean output (watts, or m/s on the speed basis). */
  avgOutput: number;
  /** Duration-weighted mean heart rate (bpm). */
  avgHeartrate: number;
  /** Output per beat: avgOutput / avgHeartrate. */
  ratio: number;
  /** Moving seconds aggregated into this half. */
  seconds: number;
}

export interface AerobicAnalysis {
  /** Which output stream fed the analysis. */
  basis: "power" | "speed";
  /** % drift of output:HR between halves; positive = second half worse. */
  decouplingPct: number;
  firstHalf: HalfSummary;
  secondHalf: HalfSummary;
  /**
   * Normalized output: Coggan normalized power on the power basis (30 s
   * rolling average, 4th-power mean), duration-weighted mean speed on the
   * speed basis.
   */
  normalizedOutput: number;
  /**
   * Efficiency factor: normalized output / average HR. Power basis: W/bpm.
   * Speed basis: metres-per-minute / bpm (the running EF convention).
   */
  efficiencyFactor: number;
  /** Normalized power / threshold power; null off the power basis or when no
   * threshold is known. */
  intensityFactor: number | null;
  /** Moving seconds analysed (after warm-up exclusion). */
  movingSeconds: number;
  /** Stopped seconds excluded via the moving stream. */
  excludedStoppedSeconds: number;
  /** Warm-up seconds excluded via options. */
  excludedWarmupSeconds: number;
  warnings: string[];
}

/** Raised for inputs the analysis cannot work with; message is user-facing. */
export class AerobicAnalysisError extends Error {}

/**
 * Sample gaps longer than this contribute only this much weight — recording
 * gaps (tunnel, watch pause without moving flags) otherwise let one sample
 * dominate the duration-weighted means.
 */
export const MAX_SAMPLE_GAP_SECONDS = 10;

/** Below this much moving time the halves are too short to mean anything. */
export const MIN_MOVING_SECONDS = 600;

/** Coggan normalized power rolling-window length. */
const NP_WINDOW_SECONDS = 30;

/**
 * Running efficiency factor: metres per minute per heartbeat, so higher is
 * better (more ground covered for each beat). The one home for the speed
 * basis convention, shared by {@link computeAerobicAnalysis} and
 * `compare-activities`: a slower pace at a proportionally lower heart rate
 * scores the same, which pace divided by heart rate did not.
 */
export function speedEfficiencyFactor(
  metersPerSecond: number,
  heartrateBpm: number,
): number {
  return (metersPerSecond * 60) / heartrateBpm;
}

/** Interpretation bands for the decoupling headline. */
export function interpretDecoupling(pct: number): string {
  if (pct < 0) {
    return "negative: the second half was more efficient; typical of a gradual warm-up or a strong negative split";
  }
  if (pct < 5) {
    return "excellent: under +5%, the effort was well within aerobic capacity";
  }
  if (pct <= 10) {
    return "moderate: +5-10% drift; sustainable but near the aerobic ceiling for this duration";
  }
  return "high: over +10%, the effort exceeded current aerobic capacity for this duration";
}

interface WeightedSample {
  weight: number;
  heartrate: number;
  output: number;
}

/**
 * Flatten the streams into duration-weighted moving samples on the chosen
 * basis, dropping stopped samples and zero/absent HR.
 */
function collectMovingSamples(
  streams: AerobicStreams,
  output: (number | null)[],
): { samples: WeightedSample[]; stoppedSeconds: number } {
  const { time, heartrate, moving } = streams;
  const samples: WeightedSample[] = [];
  let stoppedSeconds = 0;

  for (let i = 1; i < time.length; i++) {
    const dt = time[i]! - time[i - 1]!;
    if (dt <= 0) continue;
    const weight = Math.min(dt, MAX_SAMPLE_GAP_SECONDS);
    if (moving && moving[i] === false) {
      stoppedSeconds += dt;
      continue;
    }
    const hr = heartrate?.[i];
    const out = output[i];
    if (hr == null || hr <= 0 || out == null) continue;
    samples.push({ weight, heartrate: hr, output: out });
  }
  return { samples, stoppedSeconds };
}

function summarizeHalf(samples: WeightedSample[]): HalfSummary {
  let weight = 0;
  let outputSum = 0;
  let hrSum = 0;
  for (const s of samples) {
    weight += s.weight;
    outputSum += s.output * s.weight;
    hrSum += s.heartrate * s.weight;
  }
  const avgOutput = weight > 0 ? outputSum / weight : 0;
  const avgHeartrate = weight > 0 ? hrSum / weight : 0;
  return {
    avgOutput,
    avgHeartrate,
    ratio: avgHeartrate > 0 ? avgOutput / avgHeartrate : 0,
    seconds: weight,
  };
}

/**
 * Coggan normalized power over the moving samples: 30-second rolling average
 * of power, raised to the 4th power, averaged, 4th root. The window advances
 * by cumulative sample weight, so typical 1 Hz streams match the canonical
 * algorithm and sparser streams approximate it.
 */
function normalizedPower(samples: WeightedSample[]): number {
  if (samples.length === 0) return 0;
  const rolling: number[] = [];
  let windowWeight = 0;
  let windowSum = 0;
  let start = 0;
  for (let i = 0; i < samples.length; i++) {
    windowWeight += samples[i]!.weight;
    windowSum += samples[i]!.output * samples[i]!.weight;
    while (windowWeight > NP_WINDOW_SECONDS && start < i) {
      windowWeight -= samples[start]!.weight;
      windowSum -= samples[start]!.output * samples[start]!.weight;
      start++;
    }
    rolling.push(windowSum / windowWeight);
  }
  const meanFourth =
    rolling.reduce((sum, v) => sum + v ** 4, 0) / rolling.length;
  return meanFourth ** 0.25;
}

export function computeAerobicAnalysis(
  streams: AerobicStreams,
  options: AerobicAnalysisOptions = {},
): AerobicAnalysis {
  if (!streams.heartrate || streams.heartrate.length === 0) {
    throw new AerobicAnalysisError(
      "No heart rate stream is available for this activity: decoupling and efficiency need HR data.",
    );
  }
  if (streams.time.length < 2) {
    throw new AerobicAnalysisError(
      "The activity's time stream is too short to analyse.",
    );
  }

  const warnings: string[] = [];
  const hasWatts = (streams.watts?.length ?? 0) > 0;
  const basis: "power" | "speed" = hasWatts ? "power" : "speed";
  const output = hasWatts ? streams.watts! : streams.velocity_smooth;
  if (!output || output.length === 0) {
    throw new AerobicAnalysisError(
      "Neither a power nor a speed stream is available for this activity.",
    );
  }
  if (!hasWatts) {
    warnings.push(
      "No power stream; analysis uses the speed:HR ratio (Pa:Hr) instead of power:HR.",
    );
  }
  if (!streams.moving) {
    warnings.push(
      "No moving stream; stopped time could not be excluded and may inflate the drift.",
    );
  }

  const { samples, stoppedSeconds } = collectMovingSamples(streams, output);

  // Warm-up exclusion counts moving time from the start.
  const excludeWarmup = Math.max(0, options.excludeWarmupSeconds ?? 0);
  let skipped = 0;
  let firstIndex = 0;
  while (firstIndex < samples.length && skipped < excludeWarmup) {
    skipped += samples[firstIndex]!.weight;
    firstIndex++;
  }
  const analysed = samples.slice(firstIndex);

  const movingSeconds = analysed.reduce((sum, s) => sum + s.weight, 0);
  if (movingSeconds <= 0) {
    throw new AerobicAnalysisError(
      "No usable moving samples remain after exclusions: the activity may be entirely stopped time, lack HR coverage, or the warm-up exclusion may exceed its length.",
    );
  }
  if (movingSeconds < MIN_MOVING_SECONDS) {
    warnings.push(
      `Only ${Math.round(movingSeconds / 60)} minutes of moving time analysed; decoupling is unreliable under ${MIN_MOVING_SECONDS / 60} minutes.`,
    );
  }

  // Split halves by cumulative moving time.
  const halfSeconds = movingSeconds / 2;
  let cumulative = 0;
  let splitIndex = analysed.length;
  for (let i = 0; i < analysed.length; i++) {
    cumulative += analysed[i]!.weight;
    if (cumulative >= halfSeconds) {
      splitIndex = i + 1;
      break;
    }
  }
  const firstHalf = summarizeHalf(analysed.slice(0, splitIndex));
  const secondHalf = summarizeHalf(analysed.slice(splitIndex));

  if (firstHalf.ratio <= 0 || secondHalf.ratio <= 0) {
    throw new AerobicAnalysisError(
      "Could not form an output:HR ratio for both halves (zero output or heart rate).",
    );
  }

  const decouplingPct =
    ((firstHalf.ratio - secondHalf.ratio) / firstHalf.ratio) * 100;

  const whole = summarizeHalf(analysed);
  const normalizedOutput =
    basis === "power" ? normalizedPower(analysed) : whole.avgOutput;
  const efficiencyFactor =
    basis === "power"
      ? normalizedOutput / whole.avgHeartrate
      : speedEfficiencyFactor(normalizedOutput, whole.avgHeartrate);

  const thresholdPower = options.thresholdPower ?? null;
  const intensityFactor =
    basis === "power" && thresholdPower && thresholdPower > 0
      ? normalizedOutput / thresholdPower
      : null;

  return {
    basis,
    decouplingPct,
    firstHalf,
    secondHalf,
    normalizedOutput,
    efficiencyFactor,
    intensityFactor,
    movingSeconds,
    excludedStoppedSeconds: stoppedSeconds,
    excludedWarmupSeconds: skipped,
    warnings,
  };
}
