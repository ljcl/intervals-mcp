import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { formatShortDate } from "@intervals-mcp/data";
import { useId, useMemo } from "react";
import styles from "./RunSelectList.module.css";
import { type RunSummary } from "./types";

interface RunSelectListProps {
  /** Candidate runs to choose from (already filtered to those with cadence). */
  runs: RunSummary[];
  selectedRunIds: Set<string>;
  onToggleRun: (runId: string) => void;
  /** Overlay comparison cap; matches App's toggleRunSelection guard. */
  maxSelected?: number;
  mode?: "mobile" | "desktop";
}

/**
 * Keyboard- and touch-accessible run picker for the overlay comparison.
 *
 * The Trend/Scatter dots select runs on click but carry no tabindex, role, or
 * key handling, so keyboard and small-target touch users could not build a
 * comparison. This list is the accessible alternative the issue recommends
 * over fighting Recharts' SVG focus handling: a Base UI ToggleGroup (roving
 * tabindex, arrow-key navigation, one Tab stop, `role="group"`) of toggle
 * chips whose pressed state — surfaced as `aria-pressed` — mirrors
 * `selectedRunIds`. It shares App's `toggleRunSelection`, so both entry points
 * drive one selection state. At the cap, unselected chips disable so the
 * "up to N" limit is legible rather than a silently ignored click.
 */
export function RunSelectList({
  runs,
  selectedRunIds,
  onToggleRun,
  maxSelected = 4,
  mode = "desktop",
}: RunSelectListProps) {
  const isMobile = mode === "mobile";
  const headingId = useId();
  const statusId = useId();

  // Most recent first: comparisons are usually built from recent runs.
  const ordered = useMemo(
    () =>
      [...runs].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      ),
    [runs],
  );

  const selectedCount = selectedRunIds.size;
  const atCap = selectedCount >= maxSelected;

  if (ordered.length === 0) return null;

  const value = ordered.flatMap((r) =>
    selectedRunIds.has(r.id) ? [r.id] : [],
  );

  return (
    <div className={styles.wrapper} data-compact={isMobile || undefined}>
      <div className={styles.header}>
        <h3 id={headingId} className={styles.heading}>
          Compare runs
        </h3>
        <span id={statusId} className={styles.count} aria-live="polite">
          {selectedCount} of {maxSelected} selected
        </span>
      </div>
      <ToggleGroup
        multiple
        value={value}
        aria-labelledby={`${headingId} ${statusId}`}
        className={styles.list}
        data-size={isMobile ? "touch" : "default"}
      >
        {ordered.map((run) => {
          const selected = selectedRunIds.has(run.id);
          const disabled = !selected && atCap;
          const dateLabel = formatShortDate(run.date, "short");
          const cadence = Math.round(run.averageCadence);
          return (
            <Toggle
              key={run.id}
              value={run.id}
              pressed={selected}
              disabled={disabled}
              onPressedChange={() => onToggleRun(run.id)}
              className={styles.chip}
              data-selected={selected || undefined}
              title={`${run.name} · ${dateLabel} · ${cadence} spm`}
              aria-label={`${run.name}, ${dateLabel}, ${cadence} spm`}
            >
              <span className={styles.name}>{run.name}</span>
              <span className={styles.cadence}>{cadence}</span>
            </Toggle>
          );
        })}
      </ToggleGroup>
    </div>
  );
}
