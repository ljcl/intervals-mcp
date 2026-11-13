import { paceBasisNote } from "@intervals-mcp/data";
import {
  CardHeader,
  EmptyState,
  Pill,
  PillGroup,
  SummaryBar,
  useModelContextSync,
  useViewTool,
  type ViewToolRegistry,
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
import {
  describeSetZoneType,
  resolveSetZoneType,
  type SetZoneTypeArgs,
} from "./setZoneType";
import { type ActivityZonesData } from "./types";
import { ZoneChart } from "./ZoneChart";

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: ActivityZonesData;
  mode?: "mobile" | "desktop";
  viewToolRegistry?: ViewToolRegistry | null;
}

export function App({
  app,
  data,
  mode = "desktop",
  viewToolRegistry = null,
}: AppProps) {
  const isMobile = mode === "mobile";
  const [activeType, setActiveType] = useState(data.zoneSets[0]?.type);

  const activeSet =
    data.zoneSets.find((set) => set.type === activeType) ?? data.zoneSets[0];
  const stats = useMemo(
    () => (activeSet ? buildSummaryStats(activeSet) : []),
    [activeSet],
  );

  /**
   * The model's way into the set pills (declared in
   * `viewToolDeclarations.ts`). It sets the same state the pills do, and a
   * set the activity lacks is refused with nothing changed.
   */
  useViewTool(viewToolRegistry, "set-zone-type", (args) => {
    const result = resolveSetZoneType(args as SetZoneTypeArgs, data);
    if (result.kind === "error") return { text: result.text, isError: true };
    setActiveType(result.set.type);
    return { text: describeSetZoneType(result.set) };
  });

  // The set on screen is in the dependencies, so the model learns of a
  // switch the athlete made with the pills, not only one it made itself.
  useModelContextSync(
    app ?? undefined,
    () => buildZonesContextSummary(data, activeSet?.type),
    [data, activeSet?.type],
  );

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
        {/* The server dropped heart rate zones for a known reason: say so
         * beside the sets it kept, as the text tools do, so a pace-only card
         * never reads as a run without heart rate. */}
        {data.hrZoneWarning && (
          <span className={styles.footnote} data-warning="">
            {data.hrZoneWarning}
          </span>
        )}
      </div>
    </div>
  );
}
