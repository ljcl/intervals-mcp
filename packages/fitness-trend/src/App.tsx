import { fitnessSourceLabel, lookbackLabel } from "@intervals-mcp/data";
import { getChartTokens } from "@intervals-mcp/design-system";
import {
  CardHeader,
  ErrorState,
  Legend,
  LegendItem,
  LoadingState,
  Pill,
  PillGroup,
  Skeleton,
  SummaryBar,
  useModelContextSync,
  useServerToolFetcher,
  useViewTool,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./App.module.css";
import { buildFitnessTrendContextSummary } from "./contextSummary";
import {
  BAND_COLORS,
  BAND_LABELS,
  buildSummaryStats,
  buildTrendSubtitle,
  countBandKinds,
  isPlanned,
  planDays,
} from "./normalize";
import {
  describeSetScope,
  hiddenSeriesNames,
  landingFor,
  planInfo,
  resolveSetScope,
  type Scope,
  type SeriesKey,
  type SeriesVisibility,
  type SetScopeArgs,
} from "./setScope";
import { TaperPlanList } from "./TaperPlanList";
import { TrendChart } from "./TrendChart";
import {
  type FitnessTrendBaseArgs,
  type FitnessTrendData,
  type TrendBand,
} from "./types";

const scopeOf = (runOnly: boolean): Scope =>
  runOnly ? "runOnly" : "wholeBody";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  /** The scope fetched at mount (whichever `initialRunOnly` names). */
  data: FitnessTrendData;
  /** Args shared by both scopes; `runOnly` is layered on per fetch. */
  baseArgs: FitnessTrendBaseArgs;
  /** Which scope `data` belongs to: the toggle's starting position. */
  initialRunOnly: boolean;
  mode?: "mobile" | "desktop";
  viewToolRegistry?: ViewToolRegistry | null;
}

export function App({
  app,
  data: initialData,
  baseArgs,
  initialRunOnly,
  mode = "desktop",
  viewToolRegistry = null,
}: AppProps) {
  const isMobile = mode === "mobile";
  const initialScope = scopeOf(initialRunOnly);
  const otherScope: Scope =
    initialScope === "wholeBody" ? "runOnly" : "wholeBody";
  const [scope, setScope] = useState<Scope>(initialScope);

  const [showCtl, setShowCtl] = useState(true);
  const [showAtl, setShowAtl] = useState(true);
  const [showTsb, setShowTsb] = useState(true);
  const [showPlan, setShowPlan] = useState(true);
  const [hiddenBandKinds, setHiddenBandKinds] = useState<TrendBand["kind"][]>(
    [],
  );

  // The other scope's result is fetched on demand and cached by the shared
  // keyed store, so flipping back to it (or to the initial scope, already
  // held in `initialData`) never re-fetches.
  const fetcher = useServerToolFetcher<FitnessTrendData>(
    app,
    "get-fitness-trend-data",
    (key) => ({ ...baseArgs, runOnly: key === "runOnly" }),
  );
  const { request } = fetcher;
  useEffect(() => {
    if (scope === otherScope) request(otherScope);
  }, [scope, otherScope, request]);

  const otherEntry = fetcher.entries.get(otherScope);
  const scopeData = (which: Scope): FitnessTrendData | null =>
    which === initialScope ? initialData : (otherEntry?.data ?? null);
  const data = scopeData(scope);
  // Read the entry's own state. "No data yet" is not loading: a failed fetch
  // has no data either, and reading it as loading kept the skeleton up
  // forever. No entry at all means the request effect has not run yet.
  const otherLoading =
    scope === otherScope && (!otherEntry || otherEntry.loading);
  const otherError = scope === otherScope ? (otherEntry?.error ?? null) : null;
  const retryOther = useCallback(
    () => fetcher.retry(otherScope),
    [fetcher, otherScope],
  );

  const summaryStats = useMemo(
    () => (data ? buildSummaryStats(data) : []),
    [data],
  );
  const planLength = data ? planDays(data).length : 0;
  const planned = data ? isPlanned(data) : false;
  const bandKinds = useMemo(() => countBandKinds(data?.bands ?? []), [data]);

  const toggleBandKind = (kind: TrendBand["kind"]) =>
    setHiddenBandKinds((hidden) =>
      hidden.includes(kind)
        ? hidden.filter((k) => k !== kind)
        : [...hidden, kind],
    );

  // Named by the values `set-scope` accepts, so the model's summary says what
  // it can switch back. Memoised: the array is a dependency of the context sync, and one
  // rebuilt each render would restart the debounce on every render.
  const hiddenSeries = useMemo(
    () =>
      hiddenSeriesNames(
        { fitness: showCtl, fatigue: showAtl, form: showTsb, plan: showPlan },
        planInfo(data),
      ),
    [showCtl, showAtl, showTsb, showPlan, data],
  );

  /**
   * The model's way into the scope pills and the legend toggles (declared in
   * `viewToolDeclarations.ts`). Switching scope sets the same state the pills
   * do, so the effect above requests the other scope through the keyed
   * fetcher; nothing here fetches. The plan and what the card renders are
   * read from the scope the call lands on, since the scope the model is
   * switching to may differ from the one on screen: the reply says "showing"
   * only for a chart that is drawn, and a scope still loading or failed to
   * load is reported as such.
   */
  useViewTool(viewToolRegistry, "set-scope", (args) => {
    const call = args as SetScopeArgs;
    const nextScope = call.scope ?? scope;
    const nextData = scopeData(nextScope);
    const plan = planInfo(nextData);
    // The initial scope is never fetched, so only the other one can have failed.
    const landing = landingFor(
      nextScope,
      nextData,
      nextScope === initialScope ? null : (otherEntry?.error ?? null),
    );
    const result = resolveSetScope(call, plan, landing);
    if (result.kind === "error") return { text: result.text, isError: true };

    const setters: Record<SeriesKey, (shown: boolean) => void> = {
      fitness: setShowCtl,
      fatigue: setShowAtl,
      form: setShowTsb,
      plan: setShowPlan,
    };
    const entries = Object.entries(result.visible) as [SeriesKey, boolean][];
    for (const [series, shown] of entries) setters[series](shown);
    setScope(nextScope);

    // What the call left alone stays as it is, and is described as such.
    const next: SeriesVisibility = {
      fitness: showCtl,
      fatigue: showAtl,
      form: showTsb,
      plan: showPlan,
      ...result.visible,
    };
    return {
      text: describeSetScope(landing, next, plan),
      ...(landing.status === "failed" ? { isError: true } : {}),
    };
  });

  useModelContextSync(
    app ?? undefined,
    () => (data ? buildFitnessTrendContextSummary(data, hiddenSeries) : null),
    [data, hiddenSeries],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Fitness trend"
        subtitle={
          data
            ? buildTrendSubtitle(data)
            : lookbackLabel(baseArgs.days, baseArgs.newest)
        }
        compact={isMobile}
      />
      <div className={styles.scopeRow}>
        <PillGroup>
          <Pill
            active={scope === "wholeBody"}
            onClick={() => setScope("wholeBody")}
          >
            Whole body
          </Pill>
          <Pill
            active={scope === "runOnly"}
            onClick={() => setScope("runOnly")}
          >
            Runs only
          </Pill>
        </PillGroup>
        {data && (
          <span className={styles.sourceNote}>
            {fitnessSourceLabel(data.source)}
            {data.current ? ` · as of ${data.current.date}` : ""}
          </span>
        )}
      </div>
      {data?.warnings && data.warnings.length > 0 && (
        <span className={styles.sourceNote}>{data.warnings.join(" ")}</span>
      )}
      {otherLoading ? (
        <LoadingState
          label="Loading fitness trend"
          progress={otherEntry?.progress}
        >
          <Skeleton variant="bar" />
          <Skeleton variant="chart" />
        </LoadingState>
      ) : otherError || !data ? (
        <ErrorState
          message={otherError ?? "No fitness trend data available"}
          onRetry={retryOther}
        />
      ) : (
        <>
          <SummaryBar compact={isMobile} stats={summaryStats} />
          <div className={styles.viewContainer}>
            <TrendChart
              data={data}
              showCtl={showCtl}
              showAtl={showAtl}
              showTsb={showTsb}
              showPlan={showPlan}
              hiddenBandKinds={hiddenBandKinds}
              mode={mode}
            />
          </div>
          {data.taper && showPlan && (
            <TaperPlanList plan={data.taper} compact={isMobile} />
          )}
        </>
      )}
      {data && data.series.length > 0 && (
        <div className={styles.footer}>
          <Legend size={getChartTokens(mode).legendSize}>
            <LegendItem
              color="var(--chart-pace)"
              label="Fitness"
              hidden={!showCtl}
              onClick={() => setShowCtl((v) => !v)}
            />
            <LegendItem
              color="var(--chart-heartrate)"
              label="Fatigue"
              hidden={!showAtl}
              onClick={() => setShowAtl((v) => !v)}
            />
            <LegendItem
              color="var(--chart-power)"
              label="Form"
              hidden={!showTsb}
              onClick={() => setShowTsb((v) => !v)}
            />
            {planLength > 0 && (
              <LegendItem
                color="var(--color-text-tertiary)"
                label={planned ? "Taper plan" : "Rest projection"}
                hidden={!showPlan}
                onClick={() => setShowPlan((v) => !v)}
              />
            )}
            {bandKinds.map(({ kind, count }) => (
              <LegendItem
                key={kind}
                color={BAND_COLORS[kind]}
                label={`${BAND_LABELS[kind]} (${count})`}
                hidden={hiddenBandKinds.includes(kind)}
                onClick={() => toggleBandKind(kind)}
              />
            ))}
          </Legend>
        </div>
      )}
    </div>
  );
}
