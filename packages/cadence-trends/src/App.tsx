import { formatShortDate } from "@intervals-mcp/data";
import {
  CardHeader,
  Pill,
  PillGroup,
  SummaryBar,
  useModelContextSync,
  useServerToolFetcher,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useMemo, useState } from "react";
import styles from "./App.module.css";
import { buildCadenceContextSummary } from "./contextSummary";
import {
  buildCadenceSubtitle,
  computeSummaryStats,
  smoothOverlayPoints,
  toOverlayPoints,
} from "./normalize";
import { OverlayView } from "./OverlayView";
import { RunSelectList } from "./RunSelectList";
import { ScatterView } from "./ScatterView";
import { TrendView } from "./TrendView";
import {
  type CadenceTrendData,
  type OverlayStreamData,
  type RunStreamState,
  type ViewId,
} from "./types";
import { ZonesView } from "./ZonesView";

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: "trend", label: "Trend" },
  { id: "scatter", label: "Scatter" },
  { id: "zones", label: "Zones" },
  { id: "overlay", label: "Overlay" },
];

/** Overlay comparison cap, shared by the dot-click toggle and the run picker. */
const MAX_COMPARE_RUNS = 4;

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: CadenceTrendData;
  mode?: "mobile" | "desktop";
}

export function App({ app, data, mode = "desktop" }: AppProps) {
  const isMobile = mode === "mobile";
  const [activeView, setActiveView] = useState<ViewId>("trend");
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());

  // Per-run stream fetches go through the shared keyed fetcher so each run
  // carries its own loading, error, and retry — the hand-rolled
  // version dropped a failed run silently and refetched it forever.
  const streamFetcher = useServerToolFetcher<OverlayStreamData>(
    app,
    "get-activity-streams-raw",
    (runId) => ({ activity_id: runId }),
  );

  const stats = useMemo(
    () => computeSummaryStats(data.activities, data.weeks),
    [data],
  );

  const toggleRunSelection = useCallback((runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else if (next.size < MAX_COMPARE_RUNS) {
        next.add(runId);
      }
      return next;
    });
  }, []);

  const removeRun = useCallback((runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
  }, []);

  const { entries, request, retry } = streamFetcher;

  const requestStream = useCallback(
    (runId: string) => request(runId),
    [request],
  );
  const retryStream = useCallback((runId: string) => retry(runId), [retry]);

  // One state per requested run, keyed back to the run it belongs to. Only
  // the selected runs are ever requested, so this stays at most a handful.
  const streams = useMemo(() => {
    const map = new Map<string, RunStreamState>();
    for (const run of data.activities) {
      const entry = entries.get(run.id);
      if (!entry) continue;
      map.set(run.id, {
        run,
        points: entry.data
          ? smoothOverlayPoints(toOverlayPoints(entry.data))
          : null,
        loading: entry.loading,
        error: entry.error,
      });
    }
    return map;
  }, [data.activities, entries]);

  const selectedRuns = useMemo(
    () => data.activities.filter((a) => selectedRunIds.has(a.id)),
    [data.activities, selectedRunIds],
  );

  // Runs the overlay can plot (it needs a cadence stream); the same pool the
  // Trend/Scatter dots draw from, offered as a keyboard/touch picker.
  const selectableRuns = useMemo(
    () => data.activities.filter((a) => a.averageCadence > 0),
    [data.activities],
  );

  const showRunPicker = activeView === "trend" || activeView === "scatter";

  useModelContextSync(
    app ?? undefined,
    () =>
      buildCadenceContextSummary({
        weeks: data.weeks,
        activeView,
        selectedRuns,
        excludedNoCadence: data.excludedNoCadence,
      }),
    [data.weeks, activeView, selectedRuns, data.excludedNoCadence],
  );

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title="Cadence trends"
        subtitle={buildCadenceSubtitle(stats.runCount, data.weeks)}
        compact={isMobile}
      />
      <SummaryBar
        compact={isMobile}
        stats={[
          {
            label: "Avg Cadence",
            value: stats.currentAvg > 0 ? `${stats.currentAvg} spm` : "—",
          },
          {
            label: "Trend",
            value:
              stats.delta !== 0
                ? `${stats.delta > 0 ? "+" : ""}${stats.delta} spm`
                : "flat",
            direction:
              stats.delta > 0 ? "up" : stats.delta < 0 ? "down" : "flat",
          },
          { label: "Runs", value: `${stats.runCount} in ${data.weeks}w` },
        ]}
      />
      <div className={styles.nav}>
        <PillGroup>
          {VIEWS.map((v) => (
            <Pill
              key={v.id}
              active={activeView === v.id}
              onClick={() => setActiveView(v.id)}
            >
              {v.label}
            </Pill>
          ))}
        </PillGroup>
      </div>
      <div className={styles.viewContainer}>
        {activeView === "trend" && (
          <TrendView
            activities={data.activities}
            onRunClick={toggleRunSelection}
            selectedRunIds={selectedRunIds}
            mode={mode}
          />
        )}
        {activeView === "scatter" && (
          <ScatterView
            activities={data.activities}
            onRunClick={toggleRunSelection}
            selectedRunIds={selectedRunIds}
            mode={mode}
          />
        )}
        {activeView === "zones" && (
          <ZonesView activities={data.activities} mode={mode} />
        )}
        {activeView === "overlay" && (
          <OverlayView
            selectedRunIds={selectedRunIds}
            streams={streams}
            requestStream={requestStream}
            retryStream={retryStream}
            mode={mode}
          />
        )}
      </div>
      {showRunPicker && (
        <RunSelectList
          runs={selectableRuns}
          selectedRunIds={selectedRunIds}
          onToggleRun={toggleRunSelection}
          maxSelected={MAX_COMPARE_RUNS}
          mode={isMobile ? "mobile" : "desktop"}
        />
      )}
      {selectedRuns.length > 0 && (
        <div className={styles.selectionBar}>
          {selectedRuns.map((run) => (
            <div key={run.id} className={styles.selectedRun}>
              <span>
                {run.name} · {formatShortDate(run.date, "short")}
              </span>
              <button
                type="button"
                onClick={() => removeRun(run.id)}
                aria-label={`Remove ${run.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
