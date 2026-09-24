import { Collapsible } from "@base-ui/react/collapsible";
import { formatClock, formatShortDate } from "@intervals-mcp/data";
import { Chevron } from "@intervals-mcp/ui";
import styles from "./EffortList.module.css";
import {
  cadenceUnit,
  formatEffortSpeed,
  formatSecondsDelta,
} from "./normalize";
import { type SegmentEffort } from "./types";

interface EffortListProps {
  efforts: SegmentEffort[];
  /** Segment sport, so pace renders as pace only where that reads. */
  activityType: string | null;
  /** Fastest time in the history, for each effort's gap to the best. */
  bestSeconds: number | null;
  /** Label the dates with their year (history crossing new-year). */
  withYear: boolean;
  /** Notified as rows expand, so the host context can name the open effort. */
  onOpenChange: (effortId: string, open: boolean) => void;
  compact?: boolean;
}

/**
 * The efforts behind the chart, most recent first. Each row is a Base UI
 * Collapsible: the summary line carries what the chart plots (date, time,
 * gap to the best, pace, heart rate), and the panel adds the metrics that
 * would crowd it — including the parent activity id, which is how the model
 * gets from a point on the chart back to the run it came from.
 */
export function EffortList({
  efforts,
  activityType,
  bestSeconds,
  withYear,
  onOpenChange,
  compact,
}: EffortListProps) {
  return (
    <div className={styles.list} data-compact={compact || undefined}>
      <div className={styles.title}>Efforts, most recent first</div>
      <div className={styles.rows}>
        {efforts.map((effort) => (
          <EffortRow
            key={effort.id}
            effort={effort}
            activityType={activityType}
            bestSeconds={bestSeconds}
            withYear={withYear}
            onOpenChange={onOpenChange}
          />
        ))}
      </div>
    </div>
  );
}

interface EffortRowProps {
  effort: SegmentEffort;
  activityType: string | null;
  bestSeconds: number | null;
  withYear: boolean;
  onOpenChange: (effortId: string, open: boolean) => void;
}

function EffortRow({
  effort,
  activityType,
  bestSeconds,
  withYear,
  onOpenChange,
}: EffortRowProps) {
  const gap = bestSeconds == null ? null : effort.elapsedSeconds - bestSeconds;
  const tier =
    effort.rank === 1
      ? { kind: "pr" as const, label: "Best" }
      : effort.prRank != null
        ? { kind: "pr" as const, label: `PR ${effort.prRank}` }
        : effort.komRank != null
          ? { kind: "top10" as const, label: `Top ${effort.komRank}` }
          : null;

  const details: Array<{ label: string; value: string }> = [
    { label: "Rank", value: `#${effort.rank}` },
    { label: "Moving", value: formatClock(effort.movingSeconds) },
  ];
  if (effort.maxHeartrate != null) {
    details.push({
      label: "Max HR",
      value: `${Math.round(effort.maxHeartrate)} bpm`,
    });
  }
  if (effort.averageCadence != null) {
    details.push({
      label: "Cadence",
      value: `${Math.round(effort.averageCadence)} ${cadenceUnit(activityType)}`,
    });
  }
  if (effort.deviceWatts && effort.averageWatts != null) {
    details.push({
      label: "Power",
      value: `${Math.round(effort.averageWatts)} W`,
    });
  }
  if (effort.activityId) {
    details.push({ label: "Activity", value: effort.activityId });
  }

  return (
    <Collapsible.Root
      className={styles.row}
      onOpenChange={(open) => onOpenChange(effort.id, open)}
    >
      <Collapsible.Trigger className={styles.trigger}>
        <span className={styles.body}>
          <span className={styles.line1}>
            <span className={styles.date}>
              {formatShortDate(effort.date, withYear ? "short" : "none")}
            </span>
            {tier && (
              <span className={styles.badge} data-tier={tier.kind}>
                {tier.label}
              </span>
            )}
            <span className={styles.clock}>
              {formatClock(effort.elapsedSeconds)}
            </span>
          </span>
          <span className={styles.line2}>
            <span className={styles.meta}>
              {formatEffortSpeed(effort.paceSecondsPerKm, activityType)}
            </span>
            {gap != null && gap > 0 && (
              <>
                <span className={styles.sep}>·</span>
                <span className={styles.meta}>
                  {formatSecondsDelta(gap)} vs best
                </span>
              </>
            )}
            {effort.averageHeartrate != null && (
              <>
                <span className={styles.sep}>·</span>
                <span className={styles.meta}>
                  {Math.round(effort.averageHeartrate)} bpm
                </span>
              </>
            )}
          </span>
        </span>
        <Chevron />
      </Collapsible.Trigger>
      <Collapsible.Panel className={styles.panel}>
        <div className={styles.detail}>
          {details.map((d) => (
            <div key={d.label} className={styles.detailItem}>
              <span className={styles.detailLabel}>{d.label}</span>
              <span className={styles.detailValue}>{d.value}</span>
            </div>
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
