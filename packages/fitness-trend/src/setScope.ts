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
import {
  hasRecordedLoad,
  isPlanned,
  planDays,
  projectionLabel,
} from "./normalize";
import { type FitnessTrendData } from "./types";

export type { Landing, Scope };

/** The chart's series, in the order the legend draws them. */
export const SERIES = ["fitness", "fatigue", "form", "plan"] as const;
export type SeriesKey = (typeof SERIES)[number];

export type SeriesVisibility = Record<SeriesKey, boolean>;

export type SetScopeArgs = SharedSetScopeArgs<SeriesKey>;
export type SetScopeResult = SharedSetScopeResult<SeriesKey>;

/**
 * Whether the chart has a plan to show or hide, and what the legend calls it.
 * The `plan` series is either the solved taper or the rest projection, so the
 * value the tool accepts is the same for both while the name on screen is not.
 */
export interface PlanInfo {
  hasPlan: boolean;
  /** "taper plan", "rest projection" or "calendar plan projection"; absent when there is no plan to name. */
  label?: string;
}

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
    label: isPlanned(data) ? "taper plan" : projectionLabel(data).toLowerCase(),
  };
}

/**
 * The landing scope for a payload, or for the lack of one. `empty` is loaded
 * data with no recorded load.
 */
export function landingFor(
  scope: Scope,
  data: FitnessTrendData | null,
  error: string | null,
): Landing {
  return scopeLanding(scope, data ? hasRecordedLoad(data) : null, error);
}

/**
 * Settle a `set-scope` call against the chart (`settleSetScope`): a plan
 * cannot be toggled when the chart has none, and nothing can be shown on a
 * scope whose window recorded no load.
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
  const refusal =
    landing?.status === "empty"
      ? `${capitalised(scopeName(landing.scope))} has no training load recorded in this window, so there is nothing to draw. Nothing was changed.`
      : null;
  const named = [...(args.show ?? []), ...(args.hide ?? [])];
  const problems = !plan.hasPlan && named.includes("plan") ? [NO_PLAN] : [];
  return settleSetScope(args, SERIES, refusal, problems);
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
 * One line telling the model what the card now shows (`describeLanding`).
 * Takes the landing scope and visibility as they will be, not as they were
 * given, so a call that changed only one part still describes the whole view.
 * An empty scope never reaches here; `resolveSetScope` refuses it first.
 */
export function describeSetScope(
  landing: Landing,
  visible: SeriesVisibility,
  plan: PlanInfo,
): string {
  return describeLanding(landing, hiddenSeriesNames(visible, plan));
}
