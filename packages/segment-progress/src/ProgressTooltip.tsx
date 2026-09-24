import { formatClock } from "@intervals-mcp/data";
import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import {
  type ChartRow,
  cadenceUnit,
  formatEffortSpeed,
  formatSecondsDelta,
} from "./normalize";
import styles from "./ProgressTooltip.module.css";

interface ProgressTooltipPayloadItem {
  payload?: ChartRow;
}

interface ProgressTooltipProps {
  active?: boolean;
  payload?: ProgressTooltipPayloadItem[];
  /** Segment sport, so pace renders as pace only where that reads. */
  activityType: string | null;
  /** Fastest time in the history, for the per-effort gap. */
  bestSeconds: number | null;
}

export function ProgressTooltip({
  active,
  payload,
  activityType,
  bestSeconds,
}: ProgressTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  const gap = bestSeconds == null ? null : row.elapsedSeconds - bestSeconds;
  const badge =
    row.rank === 1
      ? { tier: "pr", label: "Personal best" }
      : row.prRank != null
        ? { tier: "pr", label: `Strava PR ${row.prRank}` }
        : row.komRank != null
          ? { tier: "top10", label: `Top ${row.komRank}` }
          : null;

  return (
    <Tooltip timestamp={row.label}>
      <TooltipEntry
        color="var(--chart-pace)"
        label="Time"
        value={formatClock(row.elapsedSeconds)}
        unit=""
      />
      {gap != null && gap > 0 && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="vs best"
          value={formatSecondsDelta(gap)}
          unit=""
        />
      )}
      <TooltipEntry
        color="var(--color-text-tertiary)"
        label="Pace"
        value={formatEffortSpeed(row.paceSecondsPerKm, activityType)}
        unit=""
      />
      {row.averageHeartrate != null && (
        <TooltipEntry
          color="var(--chart-heartrate)"
          label="Avg HR"
          value={`${Math.round(row.averageHeartrate)}`}
          unit="bpm"
        />
      )}
      {row.averageWatts != null && (
        <TooltipEntry
          color="var(--chart-power)"
          label="Power"
          value={`${Math.round(row.averageWatts)}`}
          unit="W"
        />
      )}
      {row.averageCadence != null && (
        <TooltipEntry
          color="var(--chart-cadence)"
          label="Cadence"
          value={`${Math.round(row.averageCadence)}`}
          unit={cadenceUnit(activityType)}
        />
      )}
      {badge && (
        <div className={styles.badge} data-tier={badge.tier}>
          {badge.label}
        </div>
      )}
    </Tooltip>
  );
}
