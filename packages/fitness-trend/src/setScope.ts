import { isPlanned, planDays } from "./normalize";
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

/**
 * Settle a `set-scope` call against the chart, before anything on screen
 * changes: a series cannot be both shown and hidden, and a plan cannot be
 * toggled when the chart has none. Either problem refuses the whole call, so a
 * half-applied change never needs explaining. Series are named by the value
 * the schema accepts, which is what the model must send back.
 */
export function resolveSetScope(
  args: SetScopeArgs,
  plan: Pick<PlanInfo, "hasPlan">,
): SetScopeResult {
  const show = [...new Set(args.show)];
  const hide = [...new Set(args.hide)];
  if (args.scope === undefined && show.length === 0 && hide.length === 0) {
    return { kind: "error", text: NEEDS_AN_ARGUMENT };
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
 * One line telling the model what the chart now shows. Takes the scope and
 * visibility as they will be, not as they were given, so a call that changed
 * only one part still describes the whole view.
 */
export function describeSetScope(
  scope: Scope,
  visible: SeriesVisibility,
  plan: PlanInfo,
): string {
  const head =
    scope === "runOnly" ? "Showing runs only." : "Showing whole body.";
  const hidden = hiddenSeriesNames(visible, plan);
  return hidden.length > 0
    ? `${head} Hidden: ${hidden.join(", ")}.`
    : `${head} Nothing hidden.`;
}
