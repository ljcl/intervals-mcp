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
  sourceLabel,
} from "./normalize";
import { TaperPlanList } from "./TaperPlanList";
import { TrendChart } from "./TrendChart";
import {
  type FitnessTrendBaseArgs,
  type FitnessTrendData,
  type TrendBand,
} from "./types";

/** Which fitness scope is on screen. */
type Scope = "wholeBody" | "runOnly";

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
}

export function App({
  app,
  data: initialData,
  baseArgs,
  initialRunOnly,
  mode = "desktop",
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
  const data: FitnessTrendData | null =
    scope === initialScope ? initialData : (otherEntry?.data ?? null);
  const otherLoading = scope === otherScope && !otherEntry?.data;
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

  useModelContextSync(
    app ?? undefined,
    () => (data ? buildFitnessTrendContextSummary(data) : null),
    [data],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Fitness trend"
        subtitle={
          data ? buildTrendSubtitle(data) : `Last ${baseArgs.days} days`
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
            {sourceLabel(data)}
            {data.current ? ` · as of ${data.current.date}` : ""}
          </span>
        )}
      </div>
      {data?.warnings && data.warnings.length > 0 && (
        <span className={styles.sourceNote}>{data.warnings.join(" ")}</span>
      )}
      {otherLoading ? (
        <LoadingState label="Loading fitness trend">
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
