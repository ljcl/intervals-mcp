import {
  formatDurationShort,
  formatPace,
  formatShortDate,
} from "@intervals-mcp/data";
import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import { Fragment } from "react";
import styles from "./SharedTooltip.module.css";

/** The run fields a tooltip reads from a chart row. */
export interface TooltipRun {
  id?: string;
  name?: string;
  date?: string;
  distance?: number;
  averageCadence?: number;
  averagePace?: number | null;
  duration?: number;
}

interface RunTooltipPayloadItem {
  name?: string;
  value?: number;
  payload?: TooltipRun;
}

interface SharedTooltipProps {
  active?: boolean;
  payload?: RunTooltipPayloadItem[];
  /**
   * Every run drawn at the hovered run's x, the hovered one included. The
   * trend's day axis puts a day's runs at one x and Recharts' axis tooltip
   * picks one row for all of them, so the trend passes the whole day here;
   * left out, the tooltip names the hovered run alone.
   */
  runsAt?: (run: TooltipRun) => TooltipRun[];
}

function CadenceEntry({ run }: { run: TooltipRun }) {
  if (run.averageCadence === undefined || run.averageCadence <= 0) return null;
  return (
    <TooltipEntry
      color="var(--chart-cadence)"
      label="Cadence"
      value={`${run.averageCadence}`}
      unit="spm"
    />
  );
}

function PaceEntry({ run }: { run: TooltipRun }) {
  if (run.averagePace == null || run.averagePace <= 0) return null;
  return (
    <TooltipEntry
      color="var(--chart-pace)"
      label="Pace"
      value={formatPace(run.averagePace)}
      unit="/km"
    />
  );
}

export function SharedTooltip({ active, payload, runsAt }: SharedTooltipProps) {
  if (!active || !payload?.length) return null;
  const run = payload[0]?.payload;
  if (!run) return null;

  const date = run.date ? formatShortDate(run.date, "short") : "";
  const runs = runsAt?.(run) ?? [run];

  // Several runs at one x: name, cadence and pace each, so the tooltip stays
  // short enough for a compact card.
  if (runs.length > 1) {
    return (
      <Tooltip timestamp={date}>
        {runs.map((r, i) => (
          <Fragment key={r.id ?? i}>
            {r.name && <div className={styles.heading}>{r.name}</div>}
            <CadenceEntry run={r} />
            <PaceEntry run={r} />
          </Fragment>
        ))}
      </Tooltip>
    );
  }

  return (
    <Tooltip timestamp={date}>
      {run.name && <div className={styles.heading}>{run.name}</div>}
      <CadenceEntry run={run} />
      <PaceEntry run={run} />
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
