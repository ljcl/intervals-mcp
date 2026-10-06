import {
  formatShortDate,
  isRunning,
  smooth,
  windowLabel,
} from "@intervals-mcp/data";
import {
  COMPARISON_COLORS,
  type OverlayPoint,
  type OverlayRunStatus,
  type OverlayStreamData,
  type OverlayXMode,
  type PaceZone,
  type RunStreamState,
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
export function buildCadenceSubtitle(runCount: number, days: number): string {
  const runLabel = `${runCount} ${runCount === 1 ? "run" : "runs"}`;
  return `${runLabel} · last ${windowLabel(days)}`;
}

/**
 * Compute summary stats: current period avg, previous period avg, delta.
 * `now` is injectable so tests are deterministic.
 */
export function computeSummaryStats(
  activities: RunSummary[],
  days: number,
  now = Date.now(),
): {
  currentAvg: number;
  previousAvg: number;
  delta: number;
  runCount: number;
} {
  const halfWindow = (days / 2) * 24 * 60 * 60 * 1000;

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

/**
 * Runs grouped by calendar day (`dayTimestamp`), each day's in the order
 * given. The trend's day axis draws a day's runs at one x, so its tooltip
 * reads the whole day from here.
 */
export function runsByDay<T extends Pick<RunSummary, "date">>(
  runs: readonly T[],
): Map<number, T[]> {
  const byDay = new Map<number, T[]>();
  for (const run of runs) {
    const day = dayTimestamp(run.date);
    const list = byDay.get(day);
    if (list) list.push(run);
    else byDay.set(day, [run]);
  }
  return byDay;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days the trend's rolling average reaches back, the run's own day included. */
export const TREND_WINDOW_DAYS = 14;

/** One run's point on the trend's rolling-average line. */
export interface TrendAveragePoint {
  id: string;
  date: string;
  /** Mean cadence over the window; null when no run in it has cadence. */
  cadence: number | null;
  /**
   * Which unbroken stretch of line the point belongs to. It goes up by one
   * after a break of more than `windowDays` between consecutive runs, where
   * the line stops instead of joining the runs either side.
   */
  segment: number;
}

/**
 * Trailing rolling average of cadence by time, not run count: each run
 * averages every run whose UTC day (`dayTimestamp`) falls in the
 * `windowDays` days up to and including its own, ignoring cadence of 0 or
 * below. Runs on one day share a window, so they share an average. Sorted
 * oldest first, keeping the given order within a day.
 */
export function timeRollingAverage(
  runs: readonly RunSummary[],
  windowDays: number,
): TrendAveragePoint[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const days = sorted.map((r) => dayTimestamp(r.date));
  const reach = (windowDays - 1) * DAY_MS;
  let segment = 0;
  return sorted.map((run, i) => {
    const day = days[i]!;
    if (i > 0 && day - days[i - 1]! > windowDays * DAY_MS) segment += 1;
    let sum = 0;
    let count = 0;
    sorted.forEach((other, j) => {
      const otherDay = days[j]!;
      if (otherDay > day || otherDay < day - reach) return;
      if (other.averageCadence <= 0) return;
      sum += other.averageCadence;
      count += 1;
    });
    return {
      id: run.id,
      date: run.date,
      cadence: count > 0 ? Math.round(sum / count) : null,
      segment,
    };
  });
}

/** At most this many intervals between trend axis ticks, so five ticks. */
const TREND_TICK_INTERVALS = 4;

/**
 * X-axis domain and ticks for the trend timeline, every tick on a UTC day
 * boundary. Left to Recharts, the axis ticks every run's x, so two runs on
 * one day repeat its label and the ticks space unevenly (#145). These step
 * whole days, `ceil(span / 4)` at a time, from the first run's day to the
 * last. When every run falls on one day the span is empty, so it
 * widens by a day each side with one tick on the day.
 */
export function trendTimeAxis(timestamps: number[]): {
  domain: [number, number];
  ticks: number[];
} {
  const first = Math.floor(Math.min(...timestamps) / DAY_MS) * DAY_MS;
  const last = Math.max(...timestamps);
  if (last - first < DAY_MS) {
    return { domain: [first - DAY_MS, first + DAY_MS], ticks: [first] };
  }
  const spanDays = Math.floor((last - first) / DAY_MS);
  const step = Math.ceil(spanDays / TREND_TICK_INTERVALS) * DAY_MS;
  const ticks: number[] = [];
  for (let tick = first; tick <= last; tick += step) ticks.push(tick);
  return { domain: [first, last], ticks };
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

/**
 * One selected run's place in the overlay, from its stream fetch and the
 * legend. The overlay draws from the same reading, and the `set-view` reply
 * and context summary claim only what it says is drawn. A run with no fetch
 * yet counts as loading: its request goes out once the overlay mounts.
 */
export function overlayRunStatus(
  state: RunStreamState | undefined,
  hidden: boolean,
): OverlayRunStatus {
  if (!state || state.loading) return "loading";
  if (state.error != null) return "failed";
  if (state.noStreams) return "noStreams";
  if (!state.points) return "loading";
  return hidden ? "hidden" : "drawn";
}
