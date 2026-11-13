import { type IntensitySplit } from "@intervals-mcp/data";
import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import styles from "./LoadTooltip.module.css";
import {
  buildLoadBreakdown,
  formatHours,
  formatIntensityShort,
} from "./normalize";
import { type LongRun } from "./types";

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
    /** "in progress" or "partial" on the partial week; see `buildLoadRows`. */
    partialLabel?: string | null;
    warning?: boolean;
    warningReasons?: string[];
    /** Null for a week with no run HR data: the row is left out, never 0%. */
    intensity?: IntensitySplit | null;
    longRun?: LongRun | null;
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

  // "Week of 6 Apr (in progress)", or "(partial)" for a past window.
  const heading = week.weekLabel
    ? `Week of ${week.weekLabel}${week.partialLabel ? ` (${week.partialLabel})` : ""}`
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
      {week.intensity && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="easy/mod/hard"
          value={formatIntensityShort(week.intensity)}
          unit=""
        />
      )}
      {week.longRun && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label={`long run (${week.longRun.pct}% of week)`}
          value={`${week.longRun.km}`}
          unit="km"
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
