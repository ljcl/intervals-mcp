import { CardHeader, EmptyState, useModelContextSync } from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import styles from "./App.module.css";
import { buildWellnessContextSummary } from "./contextSummary";
import { buildSubtitle, chartedSeries } from "./normalize";
import { type WellnessTrendData } from "./types";
import { WellnessChart } from "./WellnessChart";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: WellnessTrendData;
  mode?: "mobile" | "desktop";
}

export function App({ app, data, mode = "desktop" }: AppProps) {
  const isMobile = mode === "mobile";

  useModelContextSync(
    app ?? undefined,
    () => buildWellnessContextSummary(data),
    [data],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Wellness trend"
        subtitle={buildSubtitle(data)}
        compact={isMobile}
      />
      {chartedSeries(data).length === 0 ? (
        <EmptyState>
          No HRV, resting heart rate or sleep recorded in this range.
        </EmptyState>
      ) : (
        <div className={styles.viewContainer}>
          <WellnessChart data={data} mode={mode} />
        </div>
      )}
    </div>
  );
}
