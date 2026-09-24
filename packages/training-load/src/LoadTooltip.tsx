import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import styles from "./LoadTooltip.module.css";
import { formatHours } from "./normalize";

interface WeekTooltipPayloadItem {
  payload?: {
    weekLabel?: string;
    runs?: number;
    distanceKm?: number;
    timeHours?: number;
    elevationM?: number;
    trendKm?: number;
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

  return (
    <Tooltip timestamp={week.weekLabel ? `Week of ${week.weekLabel}` : ""}>
      {week.distanceKm !== undefined && (
        <TooltipEntry
          color={week.warning ? "var(--chart-heartrate)" : "var(--chart-pace)"}
          label="Distance"
          value={`${week.distanceKm}`}
          unit="km"
        />
      )}
      {week.trendKm !== undefined && (
        <TooltipEntry
          color="var(--chart-cadence)"
          label="Trend"
          value={`${week.trendKm}`}
          unit="km"
        />
      )}
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
