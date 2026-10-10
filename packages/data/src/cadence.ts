/**
 * Cadence against pace, the one home for these numbers: the cadence-trends
 * app's zone and scatter views and the server's view-cadence-trends text
 * both read them here, so the chart and the text can never disagree.
 */

/**
 * A pace zone in min/km; a lower number is a faster pace. A zone holds a
 * pace from `minPace` (its fast limit, inclusive) up to `maxPace` (its slow
 * limit, exclusive). null is an open end: the fastest zone has no fast limit
 * and the slowest no slow limit.
 */
export interface PaceZone {
  label: string;
  minPace: number | null;
  maxPace: number | null;
}

/**
 * Fixed pace zones in min/km, fastest first: the fallback for an athlete
 * whose Run sport settings have no threshold pace or pace zones.
 */
export const PACE_ZONES: PaceZone[] = [
  { label: "Threshold", minPace: null, maxPace: 4 },
  { label: "Tempo", minPace: 4, maxPace: 4.5 },
  { label: "Moderate", minPace: 4.5, maxPace: 5.5 },
  { label: "Easy", minPace: 5.5, maxPace: null },
];

/** True when `pace` (min/km) is in `zone`. */
function paceInZone(pace: number, zone: PaceZone): boolean {
  return (
    (zone.minPace == null || pace >= zone.minPace) &&
    (zone.maxPace == null || pace < zone.maxPace)
  );
}

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

/**
 * Group activities by pace zone and compute per-zone stats, one per zone in
 * the order given: the athlete's own zones when the feed has them, else
 * {@link PACE_ZONES}.
 */
export function computeZoneStats(
  activities: CadencePaceRun[],
  zones: readonly PaceZone[] = PACE_ZONES,
): ZoneStat[] {
  return zones.map((zone) => {
    const inZone = activities.filter(
      (a) =>
        a.averagePace != null &&
        paceInZone(a.averagePace, zone) &&
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
