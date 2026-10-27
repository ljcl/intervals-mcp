import {
  capitalised,
  describeLanding,
  type Landing,
  type Scope,
  type SetScopeArgs as SharedSetScopeArgs,
  type SetScopeResult as SharedSetScopeResult,
  scopeLanding,
  scopeName,
  settleSetScope,
} from "@intervals-mcp/ui";
import { countWarningWeeks } from "./normalize";
import { type TrainingLoadData } from "./types";

export type { Landing, Scope };

/** The legend's toggleable series, in the order the legend draws them. */
export const SERIES = ["trend", "load", "warnings"] as const;
export type SeriesKey = (typeof SERIES)[number];

export type SeriesVisibility = Record<SeriesKey, boolean>;

export type SetScopeArgs = SharedSetScopeArgs<SeriesKey>;
export type SetScopeResult = SharedSetScopeResult<SeriesKey>;

const NO_WARNINGS =
  "No week in this window is flagged as a volume spike, so there are no warnings to show or hide.";

/**
 * Whether the chart has warning weeks to highlight, which is when the legend
 * offers the toggle. Data that has not loaded yet is given the benefit of the
 * doubt: warnings cannot be ruled out for a scope still being fetched, and a
 * toggle for warnings that never arrive changes nothing on screen.
 */
export function hasWarningWeeks(data: TrainingLoadData | null): boolean {
  return data ? countWarningWeeks(data.weeks) > 0 : true;
}

/**
 * The landing scope for a payload, or for the lack of one. `empty` is loaded
 * data with no run weeks: the chart is an EmptyState with no legend, while
 * the tiles still show the scope's totals and fitness.
 */
export function landingFor(
  scope: Scope,
  data: TrainingLoadData | null,
  error: string | null,
): Landing {
  return scopeLanding(scope, data ? data.weeks.length > 0 : null, error);
}

/**
 * Settle a `set-scope` call against the chart (`settleSetScope`): warnings
 * cannot be toggled when no week is flagged, and no series can be toggled on
 * a scope with no chart (it has no legend). A scope on its own is accepted
 * even with no chart, since the tiles still change with it.
 *
 * A scope that is loading or failed to load is not refused: the state is kept
 * for when the chart arrives, and `describeSetScope` says what is on screen.
 * `landing` is omitted where the render state does not matter.
 */
export function resolveSetScope(
  args: SetScopeArgs,
  hasWarnings: boolean,
  landing?: Landing,
): SetScopeResult {
  const named = [...(args.show ?? []), ...(args.hide ?? [])];
  const refusal =
    landing?.status === "empty" && named.length > 0
      ? `${capitalised(scopeName(landing.scope))} has no runs in this period, so there is no chart to show or hide series on. Nothing was changed.`
      : null;
  const problems =
    !hasWarnings && named.includes("warnings") ? [NO_WARNINGS] : [];
  return settleSetScope(args, SERIES, refusal, problems);
}

/**
 * The hidden series in legend order, each by the value the tool accepts.
 * Warnings the chart does not have are not hidden, so they are not listed.
 */
export function hiddenSeriesNames(
  visible: SeriesVisibility,
  hasWarnings: boolean,
): string[] {
  return SERIES.filter(
    (series) => !visible[series] && (series !== "warnings" || hasWarnings),
  );
}

/**
 * One line telling the model what the card now shows (`describeLanding`).
 * Takes the landing scope and visibility as they will be, not as they were
 * given, so a call that changed only one part still describes the whole view.
 * A scope with no runs says only the tiles show (there is no legend to
 * report on).
 */
export function describeSetScope(
  landing: Landing,
  visible: SeriesVisibility,
  hasWarnings: boolean,
): string {
  if (landing.status === "empty") {
    return `Showing ${scopeName(landing.scope)}: no runs in this period, so no chart is drawn, only the totals and fitness tiles.`;
  }
  return describeLanding(landing, hiddenSeriesNames(visible, hasWarnings));
}
