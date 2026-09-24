import { getChartTokens } from "@intervals-mcp/design-system";
import {
  CardHeader,
  EmptyState,
  Legend,
  LegendItem,
  SummaryBar,
  useModelContextSync,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useMemo, useState } from "react";
import styles from "./App.module.css";
import { buildSegmentProgressContextSummary } from "./contextSummary";
import { EffortList } from "./EffortList";
import {
  buildSegmentSubtitle,
  buildSummaryStats,
  hasHeartrate,
  newestFirst,
  spansMultipleYears,
} from "./normalize";
import { ProgressChart } from "./ProgressChart";
import { type SegmentProgressData } from "./types";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: SegmentProgressData;
  mode?: "mobile" | "desktop";
}

export function App({ app, data, mode = "desktop" }: AppProps) {
  const isMobile = mode === "mobile";
  const [showHeartrate, setShowHeartrate] = useState(true);
  const [openEffortId, setOpenEffortId] = useState<string | null>(null);

  const stats = useMemo(() => buildSummaryStats(data.summary), [data.summary]);
  const listed = useMemo(() => newestFirst(data.efforts), [data.efforts]);
  const withYear = useMemo(
    () => spansMultipleYears(data.efforts),
    [data.efforts],
  );
  const heartrateAvailable = useMemo(
    () => hasHeartrate(data.efforts),
    [data.efforts],
  );

  const onOpenChange = useCallback((effortId: string, open: boolean) => {
    setOpenEffortId((current) =>
      open ? effortId : current === effortId ? null : current,
    );
  }, []);

  useModelContextSync(
    app ?? undefined,
    () => buildSegmentProgressContextSummary(data, openEffortId),
    [data, openEffortId],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title={data.segment.name}
        subtitle={buildSegmentSubtitle(data.segment)}
        compact={isMobile}
      />
      {data.efforts.length === 0 ? (
        <EmptyState>No efforts on this segment in this date range.</EmptyState>
      ) : (
        <>
          <SummaryBar compact={isMobile} stats={stats} />
          <div className={styles.viewContainer}>
            <ProgressChart
              segment={data.segment}
              efforts={data.efforts}
              summary={data.summary}
              showHeartrate={showHeartrate}
              mode={mode}
            />
          </div>
          {heartrateAvailable && (
            <div className={styles.footer}>
              <Legend size={getChartTokens(mode).legendSize}>
                <LegendItem
                  color="var(--chart-heartrate)"
                  label="Avg heart rate"
                  hidden={!showHeartrate}
                  onClick={() => setShowHeartrate((v) => !v)}
                />
              </Legend>
            </div>
          )}
          <EffortList
            efforts={listed}
            activityType={data.segment.activityType}
            bestSeconds={data.summary.bestSeconds}
            withYear={withYear}
            onOpenChange={onOpenChange}
            compact={isMobile}
          />
        </>
      )}
    </div>
  );
}
