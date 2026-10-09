import {
  fitnessSourceLabel,
  formatDurationShort,
  formatShortDate,
  formatSignedTsb,
  lookbackLabel,
} from "@intervals-mcp/data";
import { type SummaryStat } from "@intervals-mcp/ui";
import {
  type TrainingLoadCurrent,
  type TrainingLoadData,
  type WeekSummary,
} from "./types";

/** What load and CTL/ATL/TSB were summed over, and where `current` came from. */
type LoadScope = Pick<
  TrainingLoadData,
  "runOnly" | "activityTypesIncluded" | "current" | "source"
>;

/**
 * Weekly totals arrive as fractional hours; the shared formatter takes
 * seconds. "27h 45m", "3h", "45m".
 */
export function formatHours(timeHours: number): string {
  return formatDurationShort(timeHours * 3600);
}

/**
 * The arguments `get-training-load-data` is called with. A type alias, not an
 * interface, so it passes as the tool's `Record<string, unknown>` arguments.
 */
export type TrainingLoadDataArgs = {
  days: number;
  runOnly: boolean;
  newest?: string;
};

/**
 * What the app asks `get-training-load-data` for, from what the host called
 * `view-training-load` with. `runOnly` must travel: the data tool defaults to
 * whole-body, so dropping it would draw a whole-body chart under a run-only
 * request. `newest` must travel too: the data tool ends the window today
 * without it. The other scope's fetch spreads these, so it gets the same
 * window. Defaults match the view tool's.
 */
export function buildDataArgs(args: {
  days?: number;
  runOnly?: boolean;
  newest?: string;
}): TrainingLoadDataArgs {
  return {
    days: args.days ?? 84,
    runOnly: args.runOnly ?? false,
    ...(args.newest ? { newest: args.newest } : {}),
  };
}

/**
 * True for a past window (`newest` before today, #80): its partial last
 * week is cut off at `endDate`, not in progress. Older payloads carry no
 * `endsToday`, and read as today. The one rule the legend, tooltip,
 * subtitle, narration and model context read.
 */
export function isPastWindow(
  data: Pick<TrainingLoadData, "endsToday">,
): boolean {
  return data.endsToday === false;
}

/**
 * What the partial last week is called: "in progress" when the window ends
 * today, "partial" when a past `newest` cuts it off.
 */
export function partialWeekWord(
  data: Pick<TrainingLoadData, "endsToday">,
): "in progress" | "partial" {
  return isPastWindow(data) ? "partial" : "in progress";
}

/**
 * SummaryBar row: runs, distance and load for the window, then fitness,
 * fatigue and form as of `current`. The three fitness tiles are dashes when
 * there is no wellness to read, so the row keeps its shape.
 */
export function buildTotalsStats(
  totals: TrainingLoadData["totals"],
  current: TrainingLoadCurrent | null,
): SummaryStat[] {
  return [
    { label: "Runs", value: `${totals.runs}` },
    { label: "Distance", value: `${totals.distanceKm.toLocaleString()} km` },
    { label: "Load", value: totals.load.toLocaleString() },
    { label: "Fitness", value: current ? `${current.ctl}` : "—" },
    { label: "Fatigue", value: current ? `${current.atl}` : "—" },
    { label: "Form", value: current ? formatSignedTsb(current.tsb) : "—" },
  ];
}

/** "(Ride, Run)", or nothing when no activity type carried load. */
const typeList = (types: string[]) =>
  types.length > 0 ? ` (${types.join(", ")})` : "";

/**
 * The scope note under the totals: what the load line and the fitness tiles
 * add up, and where CTL/ATL/TSB came from. "Whole-body load (Run, Ride) ·
 * from intervals.icu as of 5 Oct" / "Run-only load · computed locally as of
 * 5 Oct". Volume and warnings are run-based either way, so the note speaks
 * only for load and fitness. No "as of" without a `current`.
 */
export function buildScopeNote(scope: LoadScope): string {
  const load = scope.runOnly
    ? "Run-only load"
    : `Whole-body load${typeList(scope.activityTypesIncluded)}`;
  const source = fitnessSourceLabel(scope.source).toLowerCase();
  const asOf = scope.current
    ? ` as of ${formatShortDate(scope.current.date)}`
    : "";
  return `${load} · ${source}${asOf}`;
}

/**
 * The scope in a sentence for the narration and the model context: "whole
 * body (Ride, Run)" or "runs only".
 */
export function describeLoadScope(
  scope: Pick<LoadScope, "runOnly" | "activityTypesIncluded">,
): string {
  return scope.runOnly
    ? "runs only"
    : `whole body${typeList(scope.activityTypesIncluded)}`;
}

/**
 * "CTL 52, ATL 61, TSB -9 (from intervals.icu)": the same three numbers as
 * the Fitness, Fatigue and Form tiles, with where they came from, for the
 * narration and the model context.
 */
export function formatCurrentFitness(
  current: TrainingLoadCurrent,
  source: TrainingLoadData["source"],
): string {
  return `CTL ${current.ctl}, ATL ${current.atl}, TSB ${formatSignedTsb(current.tsb)} (${fitnessSourceLabel(source).toLowerCase()})`;
}

/** A week as the chart plots it: the week itself plus its label and load series. */
export interface LoadRow extends WeekSummary {
  /** X-axis tick, "22 Jun". */
  weekLabel: string;
  /** Load for the solid line: complete weeks only. */
  loadComplete: number | null;
  /** Load of the partial week, for its own hollow point. */
  loadSoFar: number | null;
  /** The tooltip's word for the partial week ("in progress" or "partial"); null on a complete week. */
  partialLabel: string | null;
}

/**
 * One chart row per week. The partial week (in progress, or cut off at a
 * past `newest`) holds only the days read, so its load stays off the solid
 * line (as `trendKm` is null for it) and is drawn as a hollow point of its
 * own, beside the dashed partial bar: on the line it would read as a plunge
 * in load. `load` itself is kept for the tooltip. `endsToday` (the
 * payload's, default true) picks the word the tooltip gives that week.
 */
export function buildLoadRows(
  weeks: WeekSummary[],
  endsToday = true,
): LoadRow[] {
  return weeks.map((week) => ({
    ...week,
    weekLabel: formatShortDate(week.weekStarting),
    loadComplete: week.inProgress ? null : week.load,
    loadSoFar: week.inProgress ? week.load : null,
    partialLabel: week.inProgress ? partialWeekWord({ endsToday }) : null,
  }));
}

/**
 * A week's load by activity type, largest first. Equal loads fall back to
 * the type name so the tooltip rows do not reorder between renders.
 */
export function buildLoadBreakdown(week: {
  loadByType?: Record<string, number>;
}): Array<{ type: string; load: number }> {
  return Object.entries(week.loadByType ?? {})
    .map(([type, load]) => ({ type, load }))
    .sort((a, b) => b.load - a.load || a.type.localeCompare(b.type));
}

/** Count of weeks carrying at least one volume-spike warning. */
export function countWarningWeeks(weeks: WeekSummary[]): number {
  return weeks.filter((w) => w.warning).length;
}

/**
 * "12 weeks · 4 May – 20 Jul" — the header subtitle. Spans the weeks
 * actually charted rather than the requested `days` window, since gap weeks
 * are zero-filled but a short history still starts where it starts. A past
 * window (#80) ends the span on its last day, year included ("12 weeks ·
 * 19 Jan – 12 Apr 2026"), so last year's weeks never read as this year's.
 * With no weeks, the window itself ("Last 84 days", or "87 days to 8 Apr
 * 2026").
 */
export function buildLoadSubtitle(data: TrainingLoadData): string {
  const pastEnd = isPastWindow(data) ? data.endDate : undefined;
  const first = data.weeks[0];
  const last = data.weeks[data.weeks.length - 1];
  if (!first || !last) return lookbackLabel(data.days, pastEnd);

  const weekLabel = `${data.weeks.length} ${data.weeks.length === 1 ? "week" : "weeks"}`;
  if (pastEnd) {
    // The start names its year only when it differs from the end's.
    const start = formatShortDate(
      first.weekStarting,
      first.weekStarting.slice(0, 4) === pastEnd.slice(0, 4) ? "none" : "full",
    );
    return `${weekLabel} · ${start} – ${formatShortDate(pastEnd, "full")}`;
  }
  const span =
    first.weekStarting === last.weekStarting
      ? formatShortDate(first.weekStarting)
      : `${formatShortDate(first.weekStarting)} – ${formatShortDate(last.weekStarting)}`;
  return `${weekLabel} · ${span}`;
}
