import { getChartTokens } from "@intervals-mcp/design-system";
import {
  CardHeader,
  Legend,
  LegendItem,
  SummaryBar,
  useModelContextSync,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useMemo, useState } from "react";
import styles from "./App.module.css";
import { buildTrainingLoadContextSummary } from "./contextSummary";
import { LoadChart } from "./LoadChart";
import {
  buildLoadSubtitle,
  buildScopeNote,
  buildTotalsStats,
  countWarningWeeks,
} from "./normalize";
import { type TrainingLoadData } from "./types";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: TrainingLoadData;
  mode?: "mobile" | "desktop";
}

export function App({ app, data, mode = "desktop" }: AppProps) {
  const isMobile = mode === "mobile";
  const [showTrend, setShowTrend] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);
  const [showLoad, setShowLoad] = useState(true);

  const totalsStats = useMemo(
    () => buildTotalsStats(data.totals, data.current),
    [data],
  );
  const scopeNote = useMemo(() => buildScopeNote(data), [data]);
  const warningWeeks = useMemo(() => countWarningWeeks(data.weeks), [data]);
  const hasWeekInProgress = data.weeks.some((w) => w.inProgress);

  useModelContextSync(
    app ?? undefined,
    () => buildTrainingLoadContextSummary(data),
    [data],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Training load"
        subtitle={buildLoadSubtitle(data)}
        compact={isMobile}
      />
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
      {data.weeks.length > 0 && (
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
            {/* The light bar is the current week, so a short bar reads as
             * "not over yet" rather than a drop in volume. */}
            {hasWeekInProgress && (
              <LegendItem
                color="color-mix(in srgb, var(--chart-pace) 35%, transparent)"
                label="This week so far"
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
