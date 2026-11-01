import { paceBasisNote } from "@intervals-mcp/data";
import {
  CardHeader,
  EmptyState,
  Pill,
  PillGroup,
  SummaryBar,
  useModelContextSync,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useMemo, useState } from "react";
import styles from "./App.module.css";
import { buildZonesContextSummary } from "./contextSummary";
import {
  buildEmptyMessage,
  buildSummaryStats,
  buildZonesSubtitle,
  ZONE_SET_NAMES,
} from "./normalize";
import { type ActivityZonesData } from "./types";
import { ZoneChart } from "./ZoneChart";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: ActivityZonesData;
  mode?: "mobile" | "desktop";
}

export function App({ app, data, mode = "desktop" }: AppProps) {
  const isMobile = mode === "mobile";
  const [activeType, setActiveType] = useState(data.zoneSets[0]?.type);

  const activeSet =
    data.zoneSets.find((set) => set.type === activeType) ?? data.zoneSets[0];
  const stats = useMemo(
    () => (activeSet ? buildSummaryStats(activeSet) : []),
    [activeSet],
  );

  useModelContextSync(app ?? undefined, () => buildZonesContextSummary(data), [
    data,
  ]);

  if (!activeSet) {
    return (
      <div className={styles.container} data-compact={isMobile || undefined}>
        <CardHeader title={data.name} subtitle={data.type} compact={isMobile} />
        <EmptyState>{buildEmptyMessage(data)}</EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title={data.name}
        subtitle={buildZonesSubtitle(data, activeSet)}
        compact={isMobile}
      />
      <SummaryBar compact={isMobile} stats={stats} />
      <div className={styles.viewContainer}>
        <ZoneChart
          set={activeSet}
          activityName={data.name}
          activityType={data.type}
          mode={mode}
        />
      </div>
      <div className={styles.footer}>
        {data.zoneSets.length > 1 && (
          <PillGroup>
            {data.zoneSets.map((set) => (
              <Pill
                key={set.type}
                active={set.type === activeSet.type}
                onClick={() => setActiveType(set.type)}
              >
                {ZONE_SET_NAMES[set.type]}
              </Pill>
            ))}
          </PillGroup>
        )}
        {activeSet.sensorBased === false && (
          <span className={styles.footnote}>
            Estimated zones (no {ZONE_SET_NAMES[activeSet.type].toLowerCase()}{" "}
            sensor)
          </span>
        )}
        {activeSet.basis && (
          <span className={styles.footnote}>
            Zones: {paceBasisNote(activeSet.basis)}
          </span>
        )}
      </div>
    </div>
  );
}
