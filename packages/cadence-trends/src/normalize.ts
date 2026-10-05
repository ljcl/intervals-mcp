import { formatShortDate, isRunning, smooth } from "@intervals-mcp/data";
import {
  COMPARISON_COLORS,
  type OverlayPoint,
  type OverlayStreamData,
  type OverlayXMode,
  type PaceZone,
  type RunSummary,
} from "./types";

/** Pace zones in min/km. Lower number = faster pace. */
export const PACE_ZONES: PaceZone[] = [
  { label: "Threshold", minPace: 0, maxPace: 4 },
  { label: "Tempo", minPace: 4, maxPace: 4.5 },
  { label: "Moderate", minPace: 4.5, maxPace: 5.5 },
  { label: "Easy", minPace: 5.5, maxPace: 20 },
];

/**
 * "18 runs · last 6 weeks" — the header subtitle. Counts every run in the
 * window, including the cadence-less ones the charts drop, because it is
 * describing the window rather than the plotted series.
 */
export function buildCadenceSubtitle(runCount: number, weeks: number): string {
  const runLabel = `${runCount} ${runCount === 1 ? "run" : "runs"}`;
  return `${runLabel} · last ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}

/** Compute a rolling average over the activities array (sorted by date ascending) */
export function rollingAverage(
  activities: RunSummary[],
  window: number,
): Array<{ date: string; cadence: number }> {
  const sorted = [...activities].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  return sorted.map((_, i) => {
    const lo = Math.max(0, i - Math.floor(window / 2));
    const hi = Math.min(sorted.length - 1, i + Math.floor(window / 2));
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j += 1) {
      if (sorted[j]!.averageCadence > 0) {
        sum += sorted[j]!.averageCadence;
        count += 1;
      }
    }
    return {
      date: sorted[i]!.date,
      cadence: count > 0 ? Math.round(sum / count) : 0,
    };
  });
}

/**
 * Compute summary stats: current period avg, previous period avg, delta.
 * `now` is injectable so tests are deterministic.
 */
export function computeSummaryStats(
  activities: RunSummary[],
  weeks: number,
  now = Date.now(),
): {
  currentAvg: number;
  previousAvg: number;
  delta: number;
  runCount: number;
} {
  const halfWindow = (weeks / 2) * 7 * 24 * 60 * 60 * 1000;

  const recent = activities.filter(
    (a) =>
      now - new Date(a.date).getTime() < halfWindow && a.averageCadence > 0,
  );
  const older = activities.filter(
    (a) =>
      now - new Date(a.date).getTime() >= halfWindow && a.averageCadence > 0,
  );

  const avg = (arr: RunSummary[]) =>
    arr.length > 0
      ? Math.round(arr.reduce((s, a) => s + a.averageCadence, 0) / arr.length)
      : 0;

  const currentAvg = avg(recent);
  const previousAvg = avg(older);
  return {
    currentAvg,
    previousAvg,
    delta: currentAvg - previousAvg,
    runCount: activities.length,
  };
}

export interface ZoneStat {
  zone: PaceZone;
  mean: number;
  min: number;
  max: number;
  count: number;
}

/** Group activities by pace zone and compute per-zone stats */
export function computeZoneStats(activities: RunSummary[]): ZoneStat[] {
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

/** One drawn bar of the pace-zone chart. */
export interface ZoneRow {
  zone: string;
  mean: number;
  min: number;
  max: number;
  count: number;
  /** Position in PACE_ZONES, so a zone keeps its shade when another is empty. */
  zoneIndex: number;
  /** [mean - min, max - mean]: Recharts draws an asymmetric whisker from a pair. */
  error: [number, number];
}

/** The non-empty zones as bars, each keeping its own index into PACE_ZONES. */
export function buildZoneRows(stats: ZoneStat[]): ZoneRow[] {
  return stats.flatMap((s, zoneIndex) =>
    s.count > 0
      ? [
          {
            zone: s.zone.label,
            mean: s.mean,
            min: s.min,
            max: s.max,
            count: s.count,
            zoneIndex,
            error: [s.mean - s.min, s.max - s.mean] as [number, number],
          },
        ]
      : [],
  );
}

/**
 * A run's day as a UTC timestamp, read from the leading YYYY-MM-DD so the
 * viewer's time zone cannot move it.
 */
export function dayTimestamp(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * X-axis domain (and ticks) for the trend timeline. Normally the span of the
 * runs. When every run falls on one day that span is empty and the time
 * scale invents sub-day ticks that all read as the same date, so the span
 * widens by a day each side with one tick on the day.
 */
export function trendTimeAxis(timestamps: number[]): {
  domain: ["dataMin", "dataMax"] | [number, number];
  ticks?: number[];
} {
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  if (min !== max) return { domain: ["dataMin", "dataMax"] };
  return { domain: [min - DAY_MS, max + DAY_MS], ticks: [min] };
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

/** Convert raw stream data to overlay points for a single run */
export function toOverlayPoints(data: OverlayStreamData): OverlayPoint[] {
  const { streams } = data;
  const timeArr = streams.time ?? [];
  const distArr = streams.distance ?? [];
  const cadenceArr = streams.cadence ?? [];
  const len = timeArr.length;
  const running = isRunning(data.activityType);
  const points: OverlayPoint[] = [];

  for (let i = 0; i < len; i += 1) {
    const point: OverlayPoint = {
      distance: (distArr[i] ?? 0) / 1000,
      time: (timeArr[i] ?? 0) / 60,
    };
    if (cadenceArr[i] != null) {
      point.cadence = running ? cadenceArr[i]! * 2 : cadenceArr[i]!;
    }
    points.push(point);
  }
  return points;
}

/**
 * Split a run's points into contiguous segments of defined cadence, breaking
 * at each null/missing reading. A gap between segments stays a gap: the
 * grid never interpolates across it.
 */
function cadenceSegments(
  points: OverlayPoint[],
  xMode: OverlayXMode,
): Array<Array<{ x: number; y: number }>> {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    if (p.cadence !== undefined) {
      current.push({
        x: xMode === "distance" ? p.distance : p.time,
        y: p.cadence,
      });
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Resample each run's cadence onto a shared x grid via linear interpolation,
 * producing one merged Recharts dataset with a `cadence_<id>` key per run.
 * Every run keeps its own x values (runs at different speeds stay aligned),
 * and grid points beyond a run's extent are left undefined so its line ends
 * there instead of flat-lining out to the longest run.
 */
export function resampleOverlayRuns(
  runs: Array<{ id: string; points: OverlayPoint[] }>,
  xMode: OverlayXMode,
  gridSize = 500,
): Array<Record<string, number | undefined>> {
  const series = runs.map((run) => ({
    key: `cadence_${run.id}`,
    segments: cadenceSegments(run.points, xMode),
  }));

  const maxX = Math.max(
    0,
    ...series.map((s) =>
      s.segments.length > 0
        ? s.segments[s.segments.length - 1]![
            s.segments[s.segments.length - 1]!.length - 1
          ]!.x
        : 0,
    ),
  );
  if (maxX <= 0 || gridSize < 1) return [];

  // One ascending {segment, point} cursor per series: the grid ascends too,
  // so this stays O(points + grid) instead of O(points * grid).
  const cursors = series.map(() => ({ seg: 0, pt: 0 }));
  const rows: Array<Record<string, number | undefined>> = [];

  for (let g = 0; g <= gridSize; g += 1) {
    const x = (maxX * g) / gridSize;
    const row: Record<string, number | undefined> = { x };

    series.forEach((s, si) => {
      const segs = s.segments;
      if (segs.length === 0) return;
      const cursor = cursors[si]!;

      // Advance to the segment that could contain x (or the last one).
      while (
        cursor.seg < segs.length - 1 &&
        x > segs[cursor.seg]![segs[cursor.seg]!.length - 1]!.x
      ) {
        cursor.seg += 1;
        cursor.pt = 0;
      }

      const pts = segs[cursor.seg]!;
      // Outside every segment (before the first, or inside a gap between
      // segments): leave undefined so the line breaks or hasn't started.
      if (x < pts[0]!.x || x > pts[pts.length - 1]!.x) return;

      let i = cursor.pt;
      while (i < pts.length - 1 && pts[i + 1]!.x < x) i += 1;
      cursor.pt = i;

      const a = pts[i]!;
      const b = pts[Math.min(i + 1, pts.length - 1)]!;
      row[s.key] =
        b.x === a.x ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
    });

    rows.push(row);
  }

  return rows;
}

/** Apply simple moving average to overlay points */
export function smoothOverlayPoints(
  points: OverlayPoint[],
  windowSize = 30,
): OverlayPoint[] {
  return smooth(points, ["cadence"], windowSize);
}

/** Dot size based on distance: min 4px, max 12px, scaled linearly */
export function dotSize(distanceKm: number, maxDistanceKm: number): number {
  if (maxDistanceKm <= 0) return 6;
  const ratio = Math.min(distanceKm / maxDistanceKm, 1);
  return 4 + ratio * 8;
}

/**
 * Overlay colour per selected run, by selection order. Colours never depend
 * on which streams have loaded, so a run keeps its colour as others arrive.
 */
export function assignOverlayColors(
  selectedIds: Iterable<string>,
): Map<string, string> {
  const colors = new Map<string, string>();
  let i = 0;
  for (const id of selectedIds) {
    colors.set(id, COMPARISON_COLORS[i % COMPARISON_COLORS.length]!);
    i += 1;
  }
  return colors;
}

/**
 * A selected run's display name: its date is added only when another
 * selected run shares the name, so two "Long Run"s can be told apart.
 */
export function overlayRunLabel(
  run: Pick<RunSummary, "id" | "name" | "date">,
  selected: ReadonlyArray<Pick<RunSummary, "id" | "name">>,
): string {
  const shared = selected.some(
    (other) => other.id !== run.id && other.name === run.name,
  );
  return shared
    ? `${run.name} · ${formatShortDate(run.date, "short")}`
    : run.name;
}
