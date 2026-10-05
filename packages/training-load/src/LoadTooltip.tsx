import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import styles from "./LoadTooltip.module.css";
import { buildLoadBreakdown, formatHours } from "./normalize";

interface WeekTooltipPayloadItem {
  payload?: {
    weekLabel?: string;
    runs?: number;
    distanceKm?: number;
    timeHours?: number;
    elevationM?: number;
    trendKm?: number | null;
    load?: number;
    loadByType?: Record<string, number>;
    inProgress?: boolean;
    warning?: boolean;
    warningReasons?: string[];
  };
}

interface LoadTooltipProps {
  active?: boolean;
  payload?: WeekTooltipPayloadItem[];
}

export function LoadTooltip({ active, payload }: LoadTooltipProps) {
  if (!active || !payload?.length) return null;
  const week = payload[0]?.payload;
  if (!week) return null;

  const heading = week.weekLabel
    ? `Week of ${week.weekLabel}${week.inProgress ? " (in progress)" : ""}`
    : "";

  const breakdown = buildLoadBreakdown(week);

  return (
    <Tooltip timestamp={heading}>
      {week.distanceKm !== undefined && (
        <TooltipEntry
          color={week.warning ? "var(--chart-heartrate)" : "var(--chart-pace)"}
          label="Distance"
          value={`${week.distanceKm}`}
          unit="km"
        />
      )}
      {week.trendKm != null && (
        <TooltipEntry
          color="var(--chart-cadence)"
          label="Trend"
          value={`${week.trendKm}`}
          unit="km"
        />
      )}
      {week.load !== undefined && (
        <TooltipEntry
          color="var(--chart-power)"
          label="Load"
          value={`${week.load}`}
          unit=""
        />
      )}
      {breakdown.map(({ type, load }) => (
        <TooltipEntry
          key={type}
          color="var(--color-text-tertiary)"
          label={`${type} load`}
          value={`${load}`}
          unit=""
        />
      ))}
      {week.runs !== undefined && week.runs > 0 && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label={week.runs === 1 ? "Run" : "Runs"}
          value={`${week.runs}`}
          unit=""
        />
      )}
      {week.timeHours !== undefined && week.timeHours > 0 && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="Time"
          value={formatHours(week.timeHours)}
          unit=""
        />
      )}
      {week.elevationM !== undefined && week.elevationM > 0 && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="Elevation"
          value={`${week.elevationM}`}
          unit="m"
        />
      )}
      {week.warningReasons?.map((reason) => (
        <div key={reason} className={styles.warning}>
          ⚠ {reason}
        </div>
      ))}
    </Tooltip>
  );
}
