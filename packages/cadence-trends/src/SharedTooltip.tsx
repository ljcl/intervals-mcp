import {
  formatDurationShort,
  formatPace,
  formatShortDate,
} from "@intervals-mcp/data";
import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import styles from "./SharedTooltip.module.css";

interface RunTooltipPayloadItem {
  name?: string;
  value?: number;
  payload?: {
    name?: string;
    date?: string;
    distance?: number;
    averageCadence?: number;
    averagePace?: number | null;
    duration?: number;
  };
}

interface SharedTooltipProps {
  active?: boolean;
  payload?: RunTooltipPayloadItem[];
}

export function SharedTooltip({ active, payload }: SharedTooltipProps) {
  if (!active || !payload?.length) return null;
  const run = payload[0]?.payload;
  if (!run) return null;

  const date = run.date ? formatShortDate(run.date, "short") : "";

  return (
    <Tooltip timestamp={date}>
      {run.name && <div className={styles.heading}>{run.name}</div>}
      {run.averageCadence !== undefined && run.averageCadence > 0 && (
        <TooltipEntry
          color="var(--chart-cadence)"
          label="Cadence"
          value={`${run.averageCadence}`}
          unit="spm"
        />
      )}
      {run.averagePace != null && run.averagePace > 0 && (
        <TooltipEntry
          color="var(--chart-pace)"
          label="Pace"
          value={formatPace(run.averagePace)}
          unit="/km"
        />
      )}
      {run.distance !== undefined && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="Distance"
          value={`${run.distance}`}
          unit="km"
        />
      )}
      {run.duration !== undefined && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="Duration"
          value={formatDurationShort(run.duration)}
          unit=""
        />
      )}
    </Tooltip>
  );
}
