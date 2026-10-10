/**
 * Where two runs' difference starts: their 1 km splits paired at the same
 * distance, and whether the gap is there from km 1 or grows during the run.
 *
 * compare-activities' totals say activity 2 averaged 9 bpm more; they cannot
 * say whether that was 9 bpm from the start (the weather, or how recovered
 * the athlete was) or 2 bpm early and 16 bpm late (fatigue, or heat building
 * up). The splits come from `computeSplitAnalysis` (`splitAnalysis.ts`), so a
 * km here is the same km, pace and grade-adjusted pace get-split-analysis
 * reports, and the efficiency factor is `speedEfficiencyFactor`'s.
 */
import { speedEfficiencyFactor } from "./aerobicAnalysis";
import { formatSigned, round } from "./formatters";
import { type Split } from "./splitAnalysis";
import { formatPaceSeconds } from "./utils/running";

/** One km of both runs, activity 2 minus activity 1 in the deltas. */
export interface KmComparisonRow {
  km: number;
  pace_1_min_per_km: string | null;
  pace_2_min_per_km: string | null;
  pace_delta_sec_per_km: number | null;
  hr_1: number | null;
  hr_2: number | null;
  hr_delta_bpm: number | null;
  /** Metres per minute per beat, on `basis`. */
  efficiency_1: number | null;
  efficiency_2: number | null;
  /** (efficiency 2 − efficiency 1) / efficiency 1, in %. */
  efficiency_delta_pct: number | null;
}

export type KmVerdict = "constant offset" | "growing drift";

export interface KmComparison {
  /** gap: grade-adjusted pace on both runs; pace: moving pace. */
  basis: "gap" | "pace";
  rows: KmComparisonRow[];
  verdict: KmVerdict | null;
  /** The fitted efficiency gap at the first and the last km compared, %. */
  efficiency_gap_first_km_pct: number | null;
  efficiency_gap_last_km_pct: number | null;
  /** The fitted HR gap at the first and the last km compared, bpm. */
  hr_gap_first_km_bpm: number | null;
  hr_gap_last_km_bpm: number | null;
  interpretation: string;
}

/**
 * A fitted change in the efficiency gap from the first km to the last of
 * at least this many percentage points is drift; under it, an offset. A
 * per-km efficiency figure moves by a point or two with GPS and terrain
 * noise, and +5% is where aerobic decoupling starts to matter.
 */
export const DRIFT_THRESHOLD_PCT = 3;

/** Fewer paired km than this leave no line worth fitting. */
export const MIN_KM_FOR_VERDICT = 3;

/** Least-squares intercept and slope of `y` against `x`. */
function fitLine(
  x: number[],
  y: number[],
): { intercept: number; slope: number } {
  const n = x.length;
  const meanX = x.reduce((sum, v) => sum + v, 0) / n;
  const meanY = y.reduce((sum, v) => sum + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - meanX) * (y[i]! - meanY);
    sxx += (x[i]! - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { intercept: meanY - slope * meanX, slope };
}

const pace = (seconds: number | null) =>
  seconds == null ? null : formatPaceSeconds(seconds);

function efficiency(paceSecPerKm: number | null, hr: number | null) {
  if (paceSecPerKm == null || paceSecPerKm <= 0 || hr == null || hr <= 0)
    return null;
  return speedEfficiencyFactor(1000 / paceSecPerKm, hr);
}

/**
 * Pairs the full km both runs covered (a trailing partial split is left
 * out) and states the verdict. `gradeAdjusted` is true when both runs have
 * elevation data, so the efficiency uses grade-adjusted pace and a hillier
 * km does not read as lost efficiency. Null when the runs share no full km.
 */
export function compareKmSplits(
  splits1: Split[],
  splits2: Split[],
  gradeAdjusted: boolean,
): KmComparison | null {
  const full1 = splits1.filter((s) => !s.partial);
  const full2 = splits2.filter((s) => !s.partial);
  const count = Math.min(full1.length, full2.length);
  if (count === 0) return null;
  const basis = gradeAdjusted ? "gap" : "pace";

  const rows: KmComparisonRow[] = [];
  // The unrounded gaps of the km that have both, for the fitted line.
  const kms: number[] = [];
  const effGaps: number[] = [];
  const hrGaps: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = full1[i]!;
    const b = full2[i]!;
    const km = i + 1;
    const ef1 = efficiency(
      gradeAdjusted ? a.gapPaceSecPerKm : a.paceSecPerKm,
      a.avgHr,
    );
    const ef2 = efficiency(
      gradeAdjusted ? b.gapPaceSecPerKm : b.paceSecPerKm,
      b.avgHr,
    );
    const effGap =
      ef1 != null && ef2 != null ? ((ef2 - ef1) / ef1) * 100 : null;
    if (effGap != null) {
      kms.push(km);
      effGaps.push(effGap);
      // A km with an efficiency on both runs has HR on both.
      hrGaps.push(b.avgHr! - a.avgHr!);
    }
    rows.push({
      km,
      pace_1_min_per_km: pace(a.paceSecPerKm),
      pace_2_min_per_km: pace(b.paceSecPerKm),
      pace_delta_sec_per_km:
        a.paceSecPerKm != null && b.paceSecPerKm != null
          ? Math.round(b.paceSecPerKm - a.paceSecPerKm)
          : null,
      hr_1: a.avgHr,
      hr_2: b.avgHr,
      hr_delta_bpm:
        a.avgHr != null && b.avgHr != null ? b.avgHr - a.avgHr : null,
      efficiency_1: ef1 == null ? null : round(ef1, 3),
      efficiency_2: ef2 == null ? null : round(ef2, 3),
      efficiency_delta_pct: effGap == null ? null : round(effGap, 1),
    });
  }

  if (kms.length < MIN_KM_FOR_VERDICT)
    return {
      basis,
      rows,
      verdict: null,
      efficiency_gap_first_km_pct: null,
      efficiency_gap_last_km_pct: null,
      hr_gap_first_km_bpm: null,
      hr_gap_last_km_bpm: null,
      interpretation: `No verdict: fewer than ${MIN_KM_FOR_VERDICT} full km have heart rate in both runs.`,
    };

  const firstKm = kms[0]!;
  const lastKm = kms[kms.length - 1]!;
  const eff = fitLine(kms, effGaps);
  const hr = fitLine(kms, hrGaps);
  const effFirst = eff.intercept + eff.slope * firstKm;
  const effLast = eff.intercept + eff.slope * lastKm;
  const hrFirst = hr.intercept + hr.slope * firstKm;
  const hrLast = hr.intercept + hr.slope * lastKm;
  const change = effLast - effFirst;
  const verdict: KmVerdict =
    Math.abs(change) >= DRIFT_THRESHOLD_PCT
      ? "growing drift"
      : "constant offset";

  const effText = `the efficiency gap goes from ${formatSigned(round(effFirst, 1), 1)}% at km ${firstKm} to ${formatSigned(round(effLast, 1), 1)}% at km ${lastKm}`;
  const hrText = `the HR gap from ${formatSigned(Math.round(hrFirst))} to ${formatSigned(Math.round(hrLast))} bpm`;
  const interpretation =
    verdict === "constant offset"
      ? `Constant offset: ${effText} and ${hrText} (fitted over ${kms.length} km). A gap that is there from km ${firstKm} points to conditions or recovery, not to fatigue during the run.`
      : `Growing drift: ${effText} and ${hrText} (fitted over ${kms.length} km). ${change < 0 ? "Activity 2" : "Activity 1"} lost efficiency as the run went on, which points to fatigue, or heat building up, during the run.`;

  return {
    basis,
    rows,
    verdict,
    efficiency_gap_first_km_pct: round(effFirst, 1),
    efficiency_gap_last_km_pct: round(effLast, 1),
    hr_gap_first_km_bpm: Math.round(hrFirst),
    hr_gap_last_km_bpm: Math.round(hrLast),
    interpretation,
  };
}

/** The text table and verdict, one line per km. */
export function formatKmComparison(comparison: KmComparison): string[] {
  const lines = [
    `Per km at the same distance (activity 2 minus activity 1; efficiency ${comparison.basis === "gap" ? "on grade-adjusted pace" : "on moving pace"}):`,
  ];
  for (const row of comparison.rows) {
    const parts = [
      `pace ${row.pace_1_min_per_km ?? "n/a"} vs ${row.pace_2_min_per_km ?? "n/a"} (${row.pace_delta_sec_per_km == null ? "n/a" : `${formatSigned(row.pace_delta_sec_per_km)} s`})`,
      `HR ${row.hr_1 ?? "n/a"} vs ${row.hr_2 ?? "n/a"} (${row.hr_delta_bpm == null ? "n/a" : formatSigned(row.hr_delta_bpm)})`,
      `efficiency ${row.efficiency_delta_pct == null ? "n/a" : `${formatSigned(row.efficiency_delta_pct, 1)}%`}`,
    ];
    lines.push(`  ${`${row.km}.`.padEnd(4)} ${parts.join(", ")}`);
  }
  lines.push(`Verdict: ${comparison.interpretation}`);
  return lines;
}
