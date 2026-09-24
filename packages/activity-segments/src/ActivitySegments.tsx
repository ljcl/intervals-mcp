import { Collapsible } from "@base-ui/react/collapsible";
import { formatClock, isRunning, RAMP_GRADIENT_CSS } from "@intervals-mcp/data";
import {
  CardHeader,
  Chevron,
  EmptyState,
  type ModelContextApp,
  RampLegend,
  useModelContextSync,
} from "@intervals-mcp/ui";
import { useCallback, useMemo, useState } from "react";
import styles from "./ActivitySegments.module.css";
import { buildRowLabel, buildSegmentsA11ySummary } from "./a11y";
import { buildSegmentsContextSummary } from "./contextSummary";
import {
  buildHeatDomain,
  type Domain,
  effortKey,
  formatEffortPace,
  heatColor,
  runOrder,
  selectHighlights,
  summaryLine,
} from "./segments";
import { type ActivitySegmentsData, type SegmentEffortRow } from "./types";

interface ActivitySegmentsProps {
  data: ActivitySegmentsData;
  mode: "mobile" | "desktop";
  app?: ModelContextApp;
}

function formatGrade(grade: number): string {
  return `${grade >= 0 ? "+" : ""}${grade.toFixed(1)}%`;
}

export function ActivitySegments({ data, mode, app }: ActivitySegmentsProps) {
  const isMobile = mode === "mobile";
  const activityType = data.activityType;

  const domain = useMemo(() => buildHeatDomain(data.segments), [data.segments]);
  const highlights = useMemo(
    () => selectHighlights(data.segments),
    [data.segments],
  );
  const all = useMemo(() => runOrder(data.segments), [data.segments]);

  // Open rows tracked as "<group>:<effortKey>" — a PR effort renders in both
  // Highlights and All segments, and each copy expands independently.
  const [openRowIds, setOpenRowIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onRowOpenChange = useCallback((rowId: string, open: boolean) => {
    setOpenRowIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  }, []);

  const expanded = useMemo(() => {
    const keys = new Set(
      [...openRowIds].map((id) => id.slice(id.indexOf(":") + 1)),
    );
    return all.filter((e) => keys.has(effortKey(e)));
  }, [openRowIds, all]);

  useModelContextSync(
    app,
    () =>
      buildSegmentsContextSummary({
        activityName: data.name,
        segments: data.segments,
        expanded,
      }),
    [data, expanded],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title={data.name}
        subtitle={summaryLine(data.segments)}
        compact={isMobile}
      />

      {/* The list's shape in words. Visually hidden: sighted users read it
       * off the rows and the key below. */}
      <p className={styles.srOnly}>
        {buildSegmentsA11ySummary(data.segments, domain, activityType)}
      </p>

      {/* The dot colour is this app's primary encoding, so it gets a key:
       * without one nothing says whether hotter means faster or slower. */}
      {data.segments.length > 1 && domain.max > domain.min && (
        <div className={styles.key}>
          <RampLegend
            gradient={RAMP_GRADIENT_CSS}
            minLabel="slower"
            maxLabel="faster"
            label="how each segment's pace compares with the rest of the activity"
          />
        </div>
      )}

      {data.segments.length === 0 ? (
        <EmptyState>No segments in this activity</EmptyState>
      ) : (
        <>
          {highlights.length > 0 && (
            <SegmentGroup
              title="Highlights"
              groupId="highlights"
              rows={highlights}
              domain={domain}
              activityType={activityType}
              onRowOpenChange={onRowOpenChange}
            />
          )}
          <SegmentGroup
            title="All segments"
            groupId="all"
            rows={all}
            domain={domain}
            activityType={activityType}
            onRowOpenChange={onRowOpenChange}
          />
        </>
      )}
    </div>
  );
}

interface SegmentGroupProps {
  title: string;
  groupId: string;
  rows: SegmentEffortRow[];
  domain: Domain;
  activityType: string | null;
  onRowOpenChange: (rowId: string, open: boolean) => void;
}

function SegmentGroup({
  title,
  groupId,
  rows,
  domain,
  activityType,
  onRowOpenChange,
}: SegmentGroupProps) {
  return (
    <div className={styles.group}>
      {/* h3: the card's CardHeader owns the h2, so groups nest under it. */}
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.rows}>
        {rows.map((effort) => (
          <Row
            key={effortKey(effort)}
            rowId={`${groupId}:${effortKey(effort)}`}
            effort={effort}
            domain={domain}
            activityType={activityType}
            onOpenChange={onRowOpenChange}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  rowId: string;
  effort: SegmentEffortRow;
  domain: Domain;
  activityType: string | null;
  onOpenChange: (rowId: string, open: boolean) => void;
}

function Row({ rowId, effort, domain, activityType, onOpenChange }: RowProps) {
  const running = activityType ? isRunning(activityType) : true;
  const tier =
    effort.prRank != null
      ? { kind: "pr" as const, label: `PR ${effort.prRank}` }
      : effort.komRank != null
        ? { kind: "top10" as const, label: `Top ${effort.komRank}` }
        : null;

  const details: Array<{ label: string; value: string }> = [];
  if (effort.averageHeartrate != null) {
    const max =
      effort.maxHeartrate != null ? `/${Math.round(effort.maxHeartrate)}` : "";
    details.push({
      label: "HR",
      value: `${Math.round(effort.averageHeartrate)}${max}`,
    });
  }
  if (effort.averageCadence != null) {
    // averageCadence is already steps-per-minute for running (doubled
    // server-side in mapActivitySegments); cycling stays raw revolutions.
    details.push({
      label: "Cadence",
      value: `${Math.round(effort.averageCadence)} ${running ? "spm" : "rpm"}`,
    });
  }
  if (effort.deviceWatts && effort.averageWatts != null) {
    details.push({
      label: "Power",
      value: `${Math.round(effort.averageWatts)} W`,
    });
  }
  details.push({
    label: "Max grade",
    value: `${effort.maximumGrade.toFixed(1)}%`,
  });
  details.push({ label: "Moving", value: formatClock(effort.movingTime) });

  return (
    <Collapsible.Root
      className={styles.row}
      onOpenChange={(open) => onOpenChange(rowId, open)}
    >
      <Collapsible.Trigger
        className={styles.trigger}
        // Without this the trigger's name is the concatenation of its visible
        // text, which omits the dot entirely.
        aria-label={buildRowLabel(effort, domain, activityType)}
      >
        <span
          className={styles.dot}
          style={{ background: heatColor(effort, domain) }}
          aria-hidden="true"
        />
        <span className={styles.body}>
          <span className={styles.line1}>
            <span className={styles.name}>{effort.name}</span>
            {tier && (
              <span className={styles.badge} data-tier={tier.kind}>
                {tier.label}
              </span>
            )}
            <span className={styles.clock}>
              {formatClock(effort.elapsedTime)}
            </span>
          </span>
          <span className={styles.line2}>
            <span className={styles.meta}>
              {formatEffortPace(effort, activityType)}
            </span>
            <span className={styles.sep}>·</span>
            <span className={styles.meta}>
              {(effort.distanceMeters / 1000).toFixed(2)} km
            </span>
            <span className={styles.sep}>·</span>
            <span className={styles.meta}>
              {formatGrade(effort.averageGrade)}
            </span>
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
