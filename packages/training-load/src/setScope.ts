import { countWarningWeeks } from "./normalize";
import { type TrainingLoadData } from "./types";

/** Which load scope is on screen. */
export type Scope = "wholeBody" | "runOnly";

/** The legend's toggleable series, in the order the legend draws them. */
export const SERIES = ["trend", "load", "warnings"] as const;
export type SeriesKey = (typeof SERIES)[number];

export type SeriesVisibility = Record<SeriesKey, boolean>;

/** `set-scope` arguments after the registry has dropped the nulls. */
export interface SetScopeArgs {
  scope?: Scope;
  show?: SeriesKey[];
  hide?: SeriesKey[];
}

export interface SetScopeOk {
  kind: "ok";
  /** Absent when the call left the scope alone. */
  scope?: Scope;
  /** Only the series the call named: true to show it, false to hide it. */
  visible: Partial<SeriesVisibility>;
}

export type SetScopeResult = SetScopeOk | { kind: "error"; text: string };

/**
 * What the scope a call lands on is rendering, which decides what a reply may
 * claim. `drawn` is a chart on screen; `empty` is loaded data with no run
 * weeks, which the chart answers with an EmptyState and no legend (the tiles
 * still show the scope's totals and fitness); `loading` is a scope not yet
 * fetched or still being fetched (the skeleton); `failed` is a fetch that
 * errored (the ErrorState and its retry).
 */
export type Landing =
  | { scope: Scope; status: "drawn" | "empty" | "loading" }
  /** `error` is the fetch error as the card shows it. */
  | { scope: Scope; status: "failed"; error: string };

const NEEDS_AN_ARGUMENT = `Pass scope (wholeBody or runOnly), or name series (${SERIES.join(", ")}) in show or hide.`;

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

/** What `scope` shows as: the pill's label, in lower case. */
const scopeName = (scope: Scope): string =>
  scope === "runOnly" ? "runs only" : "whole body";

const capitalised = (text: string): string =>
  `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** The landing scope for a payload, or for the lack of one. */
export function landingFor(
  scope: Scope,
  data: TrainingLoadData | null,
  error: string | null,
): Landing {
  if (data) return { scope, status: data.weeks.length > 0 ? "drawn" : "empty" };
  return error
    ? { scope, status: "failed", error }
    : { scope, status: "loading" };
}

/**
 * Settle a `set-scope` call against the chart, before anything on screen
 * changes: a series cannot be both shown and hidden, warnings cannot be
 * toggled when no week is flagged, and no series can be toggled on a scope
 * with no chart (it has no legend). Any of these refuses the whole call, so a
 * half-applied change never needs explaining. A scope on its own is accepted
 * even with no chart, since the tiles still change with it. Series are named
 * by the value the schema accepts, which is what the model must send back.
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
  const show = [...new Set(args.show)];
  const hide = [...new Set(args.hide)];
  if (args.scope === undefined && show.length === 0 && hide.length === 0) {
    return { kind: "error", text: NEEDS_AN_ARGUMENT };
  }

  if (landing?.status === "empty" && (show.length > 0 || hide.length > 0)) {
    const name = scopeName(landing.scope);
    return {
      kind: "error",
      text: `${capitalised(name)} has no runs in this period, so there is no chart to show or hide series on. Nothing was changed.`,
    };
  }

  const problems: string[] = [];
  const both = SERIES.filter((s) => show.includes(s) && hide.includes(s));
  if (both.length > 0) {
    problems.push(`Cannot both show and hide ${both.join(", ")}.`);
  }
  if (
    !hasWarnings &&
    (show.includes("warnings") || hide.includes("warnings"))
  ) {
    problems.push(NO_WARNINGS);
  }
  if (problems.length > 0) return { kind: "error", text: problems.join(" ") };

  const visible: Partial<SeriesVisibility> = {};
  for (const series of show) visible[series] = true;
  for (const series of hide) visible[series] = false;
  return { kind: "ok", scope: args.scope, visible };
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
 * One line telling the model what the card now shows. Takes the landing scope
 * and visibility as they will be, not as they were given, so a call that
 * changed only one part still describes the whole view. It claims "showing"
 * a chart only when one is drawn: a scope still loading is switching to, one
 * that failed says so, since the card shows its error, and one with no runs
 * says only the tiles show (there is no legend to report on).
 */
export function describeSetScope(
  landing: Landing,
  visible: SeriesVisibility,
  hasWarnings: boolean,
): string {
  const name = scopeName(landing.scope);
  if (landing.status === "empty") {
    return `Showing ${name}: no runs in this period, so no chart is drawn, only the totals and fitness tiles.`;
  }
  const head =
    landing.status === "loading"
      ? `Switching to ${name}; it is still loading.`
      : landing.status === "failed"
        ? `${capitalised(name)} failed to load: ${failureReason(landing.error)}. The card shows the error with a retry.`
        : `Showing ${name}.`;
  const hidden = hiddenSeriesNames(visible, hasWarnings);
  return hidden.length > 0
    ? `${head} Hidden: ${hidden.join(", ")}.`
    : `${head} Nothing hidden.`;
}

/** The error as the card shows it, without a leading "Error:" or closing stop. */
function failureReason(error: string): string {
  return error.replace(/^Error:\s*/, "").replace(/\.+$/, "");
}
