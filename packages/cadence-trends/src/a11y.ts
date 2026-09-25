import { formatPace, formatShortDate } from "@intervals-mcp/data";
import { type RunSummary } from "./types";

/**
 * Narration spells the year out: "14 Sep 2025". intervals.icu dates are UTC
 * ISO strings and `formatShortDate` reads them in UTC, so the narrated day
 * never shifts by the viewer's (or CI's) timezone.
 */
const fullDate = (iso: string) => formatShortDate(iso, "full");

/**
 * Screen-reader narration for the four cadence-trends charts.
 * Recharts' accessibilityLayer provides keyboard focus and arrow-key
 * tooltip stepping, but the SVG carries no accessible name or content
 * summary of its own. Each builder feeds a chart's `title`/`desc` props
 * (rendered as SVG <title>/<desc>), mirroring route-map's
 * a11yDescription.ts.
 */
export interface ChartA11y {
  title: string;
  desc: string;
}

function cadenceRange(runs: RunSummary[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const run of runs) {
    if (run.averageCadence < min) min = run.averageCadence;
    if (run.averageCadence > max) max = run.averageCadence;
  }
  return { min, max };
}

function paceRange(runs: RunSummary[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const run of runs) {
    // A null pace (no recorded speed) is not a data point on this axis.
    if (run.averagePace == null) continue;
    if (run.averagePace < min) min = run.averagePace;
    if (run.averagePace > max) max = run.averagePace;
  }
  return { min, max };
}

function runCount(n: number): string {
  return `${n} run${n === 1 ? "" : "s"}`;
}

/** Trend timeline: dots per run over time with a rolling-average line. */
export function buildTrendA11y(sortedRuns: RunSummary[]): ChartA11y {
  const title = "Cadence trend timeline";
  if (sortedRuns.length === 0) return { title, desc: "No runs to display." };
  const cadence = cadenceRange(sortedRuns);
  const first = sortedRuns[0]!;
  const last = sortedRuns[sortedRuns.length - 1]!;
  const desc =
    `${runCount(sortedRuns.length)} from ${fullDate(first.date)} to ${fullDate(last.date)}. ` +
    `Average cadence ranges from ${Math.round(cadence.min)} to ${Math.round(cadence.max)} spm; ` +
    `a line shows the 5-run rolling average. ` +
    `Dot size reflects run distance. Pace dots are plotted on a secondary axis.`;
  return { title, desc };
}

/** Scatter plot: average cadence against average pace. */
export function buildScatterA11y(
  runs: RunSummary[],
  regressionSlope: number | null,
): ChartA11y {
  const title = "Cadence versus pace scatter plot";
  if (runs.length === 0) return { title, desc: "No runs to display." };
  const cadence = cadenceRange(runs);
  const pace = paceRange(runs);
  const parts = [
    `${runCount(runs.length)} plotted by average cadence against average pace.`,
    `Cadence ranges from ${Math.round(cadence.min)} to ${Math.round(cadence.max)} spm; ` +
      `pace between ${formatPace(pace.min)} and ${formatPace(pace.max)} min/km.`,
    `Larger, more opaque dots are longer, more recent runs.`,
  ];
  if (regressionSlope !== null && regressionSlope !== 0) {
    // Pace is min/km, so a negative slope means cadence rises as pace drops
    // (i.e. at faster paces).
    parts.push(
      regressionSlope < 0
        ? "The trend line shows cadence increasing at faster paces."
        : "The trend line shows cadence decreasing at faster paces.",
    );
  }
  return { title, desc: parts.join(" ") };
}

/** Pace-zone bars: mean cadence per zone with min-max error bars. */
export function buildZonesA11y(
  zones: Array<{
    zone: string;
    mean: number;
    min: number;
    max: number;
    count: number;
  }>,
): ChartA11y {
  const title = "Average cadence by pace zone";
  if (zones.length === 0) return { title, desc: "No runs to display." };
  const bars = zones
    .map(
      (zone) =>
        `${zone.zone}: ${Math.round(zone.mean)} spm average across ${runCount(zone.count)} (${Math.round(zone.min)} to ${Math.round(zone.max)})`,
    )
    .join(". ");
  return {
    title,
    desc: `Bar chart of average cadence per pace zone, with error bars marking each zone's range. ${bars}.`,
  };
}

/** Overlay: per-run cadence streams resampled onto a shared x axis. */
export function buildOverlayA11y(
  runs: Array<{ name: string; date: string }>,
  xMode: "distance" | "time",
): ChartA11y {
  const title = "Cadence overlay comparison";
  if (runs.length === 0) return { title, desc: "No runs selected." };
  const names = runs
    .map((run) => `"${run.name}" (${fullDate(run.date)})`)
    .join(", ");
  return {
    title,
    desc:
      `Cadence in spm compared ${xMode === "distance" ? "by distance in km" : "over elapsed time in minutes"} ` +
      `for ${runCount(runs.length)}: ${names}.`,
  };
}
