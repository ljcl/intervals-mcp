/**
 * Cadence against pace, the one home for these numbers: the cadence-trends
 * app's zone and scatter views and the server's view-cadence-trends text
 * both read them here, so the chart and the text can never disagree.
 */

/** A pace zone in min/km; a lower number is a faster pace. */
export interface PaceZone {
  label: string;
  minPace: number;
  maxPace: number;
}

/** Pace zones in min/km. Lower number = faster pace. */
export const PACE_ZONES: PaceZone[] = [
  { label: "Threshold", minPace: 0, maxPace: 4 },
  { label: "Tempo", minPace: 4, maxPace: 4.5 },
  { label: "Moderate", minPace: 4.5, maxPace: 5.5 },
  { label: "Easy", minPace: 5.5, maxPace: 20 },
];

/** What the zone stats read from each run. */
export interface CadencePaceRun {
  /** min/km as a decimal (5.5 is 5:30); null when no speed was recorded. */
  averagePace: number | null;
  /** Steps per minute; 0 is a dropout and is left out. */
  averageCadence: number;
}

export interface ZoneStat {
  zone: PaceZone;
  mean: number;
  min: number;
  max: number;
  count: number;
}

/** Group activities by pace zone and compute per-zone stats */
export function computeZoneStats(activities: CadencePaceRun[]): ZoneStat[] {
  return PACE_ZONES.map((zone) => {
    const inZone = activities.filter(
      (a) =>
        a.averagePace != null &&
        a.averagePace >= zone.minPace &&
        a.averagePace < zone.maxPace &&
        a.averageCadence > 0,
    );
    if (inZone.length === 0) {
      return { zone, mean: 0, min: 0, max: 0, count: 0 };
    }
    const cadences = inZone.map((a) => a.averageCadence);
    return {
      zone,
      mean: Math.round(cadences.reduce((s, c) => s + c, 0) / cadences.length),
      min: Math.min(...cadences),
      max: Math.max(...cadences),
      count: inZone.length,
    };
  });
}

/** Simple linear regression: y = slope * x + intercept */
export function linearRegression(
  points: Array<{ x: number; y: number }>,
): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * The cadence-against-pace line the scatter view draws: every run with a
 * pace and a cadence, x the pace (min/km), y the cadence (spm). A negative
 * slope means cadence rises as the pace gets faster. Null with fewer than 2
 * such runs, or when they all share one pace.
 */
export function cadencePaceRegression(
  runs: CadencePaceRun[],
): { slope: number; intercept: number; runs: number } | null {
  const points = runs.flatMap((a) =>
    a.averagePace != null && a.averagePace > 0 && a.averageCadence > 0
      ? [{ x: a.averagePace, y: a.averageCadence }]
      : [],
  );
  const fit = linearRegression(points);
  return fit ? { ...fit, runs: points.length } : null;
}
