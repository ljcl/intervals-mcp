import { lookbackLabel } from "@intervals-mcp/data";
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
import { buildTrainingLoadContextSummary } from "./contextSummary";
import { LoadChart } from "./LoadChart";
import {
  buildLoadSubtitle,
  buildScopeNote,
  buildTotalsStats,
  countWarningWeeks,
  isPastWindow,
  type TrainingLoadDataArgs,
} from "./normalize";
import {
  describeSetScope,
  hasWarningWeeks,
  hiddenSeriesNames,
  landingFor,
  resolveSetScope,
  type Scope,
  type SeriesKey,
  type SeriesVisibility,
  type SetScopeArgs,
} from "./setScope";
import { type TrainingLoadData } from "./types";

const scopeOf = (runOnly: boolean): Scope =>
  runOnly ? "runOnly" : "wholeBody";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  /** The scope fetched at mount; its `runOnly` is the pills' starting position. */
  data: TrainingLoadData;
  /**
   * What the mount fetch was called with (`buildDataArgs`). The other scope
   * is fetched with the same arguments and `runOnly` flipped.
   */
  dataArgs: TrainingLoadDataArgs;
  mode?: "mobile" | "desktop";
  viewToolRegistry?: ViewToolRegistry | null;
}

export function App({
  app,
  data: initialData,
  dataArgs,
  mode = "desktop",
  viewToolRegistry = null,
}: AppProps) {
  const isMobile = mode === "mobile";
  // Read from the payload rather than the request, so the pill always names
  // the scope the numbers on screen were summed over.
  const initialScope = scopeOf(initialData.runOnly);
  const otherScope: Scope =
    initialScope === "wholeBody" ? "runOnly" : "wholeBody";
  const [scope, setScope] = useState<Scope>(initialScope);

  const [showTrend, setShowTrend] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);
  const [showLoad, setShowLoad] = useState(true);

  // The other scope's result is fetched on demand and cached by the shared
  // keyed store, so flipping back to it (or to the initial scope, already
  // held in `initialData`) never re-fetches.
  const fetcher = useServerToolFetcher<TrainingLoadData>(
    app,
    "get-training-load-data",
    (key) => ({ ...dataArgs, runOnly: key === "runOnly" }),
  );
  const { request } = fetcher;
  useEffect(() => {
    if (scope === otherScope) request(otherScope);
  }, [scope, otherScope, request]);

  const otherEntry = fetcher.entries.get(otherScope);
  const scopeData = (which: Scope): TrainingLoadData | null =>
    which === initialScope ? initialData : (otherEntry?.data ?? null);
  // Everything below reads this one payload, so one scope's numbers never
  // show under the other's pill.
  const data = scopeData(scope);
  // Read the entry's own state. "No data yet" is not loading: a failed fetch
  // has no data either. No entry at all means the request effect has not run.
  const otherLoading =
    scope === otherScope && (!otherEntry || otherEntry.loading);
  const otherError = scope === otherScope ? (otherEntry?.error ?? null) : null;
  const retryOther = useCallback(
    () => fetcher.retry(otherScope),
    [fetcher, otherScope],
  );

  const totalsStats = useMemo(
    () => (data ? buildTotalsStats(data.totals, data.current) : []),
    [data],
  );
  const scopeNote = useMemo(() => (data ? buildScopeNote(data) : ""), [data]);
  const warningWeeks = useMemo(
    () => (data ? countWarningWeeks(data.weeks) : 0),
    [data],
  );
  const hasWeekInProgress = data?.weeks.some((w) => w.inProgress) ?? false;

  // Named by the values `set-scope` accepts, so the model's summary says what
  // it can switch back. Memoised: the array is a dependency of the context
  // sync, and one rebuilt each render would restart the debounce every render.
  const hiddenSeries = useMemo(
    () =>
      hiddenSeriesNames(
        { trend: showTrend, load: showLoad, warnings: showWarnings },
        hasWarningWeeks(data),
      ),
    [showTrend, showLoad, showWarnings, data],
  );

  /**
   * The model's way into the scope pills and the legend toggles (declared in
   * `viewToolDeclarations.ts`). Switching scope sets the same state the pills
   * do, so the effect above requests the other scope through the keyed
   * fetcher; nothing here fetches. Warnings and what the card renders are
   * read from the scope the call lands on, since it may differ from the one
   * on screen: the reply says "showing" only for a chart that is drawn, and
   * a scope still loading or failed to load is reported as such.
   */
  useViewTool(viewToolRegistry, "set-scope", (args) => {
    const call = args as SetScopeArgs;
    const nextScope = call.scope ?? scope;
    const nextData = scopeData(nextScope);
    const hasWarnings = hasWarningWeeks(nextData);
    // The initial scope is never fetched, so only the other one can have failed.
    const landing = landingFor(
      nextScope,
      nextData,
      nextScope === initialScope ? null : (otherEntry?.error ?? null),
    );
    const result = resolveSetScope(call, hasWarnings, landing);
    if (result.kind === "error") return { text: result.text, isError: true };

    const setters: Record<SeriesKey, (shown: boolean) => void> = {
      trend: setShowTrend,
      load: setShowLoad,
      warnings: setShowWarnings,
    };
    const entries = Object.entries(result.visible) as [SeriesKey, boolean][];
    for (const [series, shown] of entries) setters[series](shown);
    setScope(nextScope);

    // What the call left alone stays as it is, and is described as such.
    const next: SeriesVisibility = {
      trend: showTrend,
      load: showLoad,
      warnings: showWarnings,
      ...result.visible,
    };
    return {
      text: describeSetScope(landing, next, hasWarnings),
      ...(landing.status === "failed" ? { isError: true } : {}),
    };
  });

  useModelContextSync(
    app ?? undefined,
    () => (data ? buildTrainingLoadContextSummary(data, hiddenSeries) : null),
    [data, hiddenSeries],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Training load"
        subtitle={
          data
            ? buildLoadSubtitle(data)
            : lookbackLabel(dataArgs.days, dataArgs.newest)
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
      </div>
      {otherLoading ? (
        <LoadingState
          label="Loading training load"
          progress={otherEntry?.progress}
        >
          <Skeleton variant="bar" />
          <Skeleton variant="chart" />
        </LoadingState>
      ) : otherError || !data ? (
        <ErrorState
          message={otherError ?? "No training load data available"}
          onRetry={retryOther}
        />
      ) : (
        <>
          <SummaryBar compact={isMobile} stats={totalsStats} />
          <span className={styles.scopeNote}>{scopeNote}</span>
          <div className={styles.viewContainer}>
            <LoadChart
              data={data}
              showTrend={showTrend}
              showWarnings={showWarnings}
              showLoad={showLoad}
              mode={mode}
            />
          </div>
        </>
      )}
      {data && data.weeks.length > 0 && (
        <div className={styles.footer}>
          <Legend size={getChartTokens(mode).legendSize}>
            {/* The bars are the chart's dominant mark, so they get an entry:
             * without one nothing says what the blue means, or that the red
             * warning bars are the same measure. Static: there is nothing to
             * toggle, since hiding the volume would empty the chart. */}
            <LegendItem
              color="var(--chart-pace)"
              label="Weekly distance"
              static
            />
            {/* The light bar is the partial week, so a short bar reads as
             * "not over yet" (or, in a past window, "cut off at its last
             * day") rather than a drop in volume. */}
            {hasWeekInProgress && (
              <LegendItem
                color="color-mix(in srgb, var(--chart-pace) 35%, transparent)"
                label={isPastWindow(data) ? "Partial week" : "This week so far"}
                static
              />
            )}
            <LegendItem
              color="var(--chart-cadence)"
              label="Trend"
              hidden={!showTrend}
              onClick={() => setShowTrend((v) => !v)}
            />
            <LegendItem
              color="var(--chart-power)"
              label="Load"
              hidden={!showLoad}
              onClick={() => setShowLoad((v) => !v)}
            />
            {warningWeeks > 0 && (
              <LegendItem
                color="var(--chart-heartrate)"
                label={`Warning weeks (${warningWeeks})`}
                hidden={!showWarnings}
                onClick={() => setShowWarnings((v) => !v)}
              />
            )}
          </Legend>
        </div>
      )}
    </div>
  );
}
