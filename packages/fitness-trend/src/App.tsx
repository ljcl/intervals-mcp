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
import { TaperPlanList } from "./TaperPlanList";
import { TrendChart } from "./TrendChart";
import { type FitnessTrendData, type TrendBand } from "./types";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: FitnessTrendData;
  mode?: "mobile" | "desktop";
}

export function App({ app, data, mode = "desktop" }: AppProps) {
  const isMobile = mode === "mobile";
  const [showCtl, setShowCtl] = useState(true);
  const [showAtl, setShowAtl] = useState(true);
  const [showTsb, setShowTsb] = useState(true);
  const [showPlan, setShowPlan] = useState(true);
  const [hiddenBandKinds, setHiddenBandKinds] = useState<TrendBand["kind"][]>(
    [],
  );

  const summaryStats = useMemo(() => buildSummaryStats(data), [data]);
  const planLength = planDays(data).length;
  const planned = isPlanned(data);
  const bandKinds = useMemo(() => countBandKinds(data.bands), [data.bands]);

  const toggleBandKind = (kind: TrendBand["kind"]) =>
    setHiddenBandKinds((hidden) =>
      hidden.includes(kind)
        ? hidden.filter((k) => k !== kind)
        : [...hidden, kind],
    );

  useModelContextSync(
    app ?? undefined,
    () => buildFitnessTrendContextSummary(data),
    [data],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Fitness trend"
        subtitle={buildTrendSubtitle(data)}
        compact={isMobile}
      />
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
      {data.series.length > 0 && (
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
