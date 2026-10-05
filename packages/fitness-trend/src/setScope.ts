import { hasRecordedLoad, isPlanned, planDays } from "./normalize";
import { type FitnessTrendData } from "./types";

/** Which fitness scope is on screen. */
export type Scope = "wholeBody" | "runOnly";

/** The chart's series, in the order the legend draws them. */
export const SERIES = ["fitness", "fatigue", "form", "plan"] as const;
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
 * Whether the chart has a plan to show or hide, and what the legend calls it.
 * The `plan` series is either the solved taper or the rest projection, so the
 * value the tool accepts is the same for both while the name on screen is not.
 */
export interface PlanInfo {
  hasPlan: boolean;
  /** "taper plan" or "rest projection"; absent when there is no plan to name. */
  label?: string;
}

/**
 * What the scope a call lands on is rendering, which decides what a reply may
 * claim. `drawn` is a chart on screen; `empty` is loaded data with no recorded
 * load, which the card answers with an EmptyState; `loading` is a scope not
 * yet fetched or still being fetched (the skeleton); `failed` is a fetch that
 * errored (the ErrorState and its retry).
 */
export type Landing =
  | { scope: Scope; status: "drawn" | "empty" | "loading" }
  /** `error` is the fetch error as the card shows it. */
  | { scope: Scope; status: "failed"; error: string };

const NEEDS_AN_ARGUMENT = `Pass scope (wholeBody or runOnly), or name series (${SERIES.join(", ")}) in show or hide.`;

const NO_PLAN =
  "This chart has no plan (neither a taper plan nor a rest projection) to show or hide.";

/**
 * The plan a payload carries. Data that has not loaded yet is given the
 * benefit of the doubt: a plan cannot be ruled out for a scope still being
 * fetched, and a toggle for a plan that never arrives changes nothing on
 * screen.
 */
export function planInfo(data: FitnessTrendData | null): PlanInfo {
  if (!data) return { hasPlan: true };
  if (planDays(data).length === 0) return { hasPlan: false };
  return {
    hasPlan: true,
    label: isPlanned(data) ? "taper plan" : "rest projection",
  };
}

/** What `scope` shows as: the pill's label, in lower case. */
const scopeName = (scope: Scope): string =>
  scope === "runOnly" ? "runs only" : "whole body";

const capitalised = (text: string): string =>
  `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** The landing scope for a payload, or for the lack of one. */
export function landingFor(
  scope: Scope,
  data: FitnessTrendData | null,
  error: string | null,
): Landing {
  if (data) return { scope, status: hasRecordedLoad(data) ? "drawn" : "empty" };
  return error
    ? { scope, status: "failed", error }
    : { scope, status: "loading" };
}

/**
 * Settle a `set-scope` call against the chart, before anything on screen
 * changes: a series cannot be both shown and hidden, a plan cannot be toggled
 * when the chart has none, and nothing can be shown on a scope whose window
 * recorded no load. Any of these refuses the whole call, so a half-applied
 * change never needs explaining. Series are named by the value the schema
 * accepts, which is what the model must send back.
 *
 * A scope that is loading or failed to load is not refused: the state is kept
 * for when the chart arrives, and `describeSetScope` says what is on screen.
 * `landing` is omitted where the render state does not matter.
 */
export function resolveSetScope(
  args: SetScopeArgs,
  plan: Pick<PlanInfo, "hasPlan">,
  landing?: Landing,
): SetScopeResult {
  const show = [...new Set(args.show)];
  const hide = [...new Set(args.hide)];
  if (args.scope === undefined && show.length === 0 && hide.length === 0) {
    return { kind: "error", text: NEEDS_AN_ARGUMENT };
  }

  if (landing?.status === "empty") {
    const name = scopeName(landing.scope);
    return {
      kind: "error",
      text: `${capitalised(name)} has no training load recorded in this window, so there is nothing to draw. Nothing was changed.`,
    };
  }

  const problems: string[] = [];
  const both = SERIES.filter((s) => show.includes(s) && hide.includes(s));
  if (both.length > 0) {
    problems.push(`Cannot both show and hide ${both.join(", ")}.`);
  }
  if (!plan.hasPlan && (show.includes("plan") || hide.includes("plan"))) {
    problems.push(NO_PLAN);
  }
  if (problems.length > 0) return { kind: "error", text: problems.join(" ") };

  const visible: Partial<SeriesVisibility> = {};
  for (const series of show) visible[series] = true;
  for (const series of hide) visible[series] = false;
  return { kind: "ok", scope: args.scope, visible };
}

/**
 * The hidden series in chart order, each by the value the tool accepts, with
 * the plan's legend name beside it where there is one. A plan the chart does
 * not have is not hidden, so it is not listed.
 */
export function hiddenSeriesNames(
  visible: SeriesVisibility,
  plan: PlanInfo,
): string[] {
  return SERIES.filter(
    (series) => !visible[series] && (series !== "plan" || plan.hasPlan),
  ).map((series) =>
    series === "plan" && plan.label ? `plan (${plan.label})` : series,
  );
}

/**
 * One line telling the model what the card now shows. Takes the landing scope
 * and visibility as they will be, not as they were given, so a call that
 * changed only one part still describes the whole view. It claims "showing"
 * only for a chart that is drawn: a scope still loading is switching to, and
 * one that failed says so, since the card shows its error. An empty scope never
 * reaches here; `resolveSetScope` refuses it first.
 */
export function describeSetScope(
  landing: Landing,
  visible: SeriesVisibility,
  plan: PlanInfo,
): string {
  const name = scopeName(landing.scope);
  const head =
    landing.status === "loading"
      ? `Switching to ${name}; it is still loading.`
      : landing.status === "failed"
        ? `${capitalised(name)} failed to load: ${failureReason(landing.error)}. The card shows the error with a retry.`
        : `Showing ${name}.`;
  const hidden = hiddenSeriesNames(visible, plan);
  return hidden.length > 0
    ? `${head} Hidden: ${hidden.join(", ")}.`
    : `${head} Nothing hidden.`;
}

/** The error as the card shows it, without a leading "Error:" or closing stop. */
function failureReason(error: string): string {
  return error.replace(/^Error:\s*/, "").replace(/\.+$/, "");
}
