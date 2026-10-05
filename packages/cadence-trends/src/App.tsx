import { formatShortDate } from "@intervals-mcp/data";
import {
  CardHeader,
  Pill,
  PillGroup,
  SummaryBar,
  useModelContextSync,
  useServerToolFetcher,
  useViewTool,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useMemo, useState } from "react";
import styles from "./App.module.css";
import { buildCadenceContextSummary } from "./contextSummary";
import {
  buildCadenceSubtitle,
  computeSummaryStats,
  overlayRunStatus,
  smoothOverlayPoints,
  toOverlayPoints,
} from "./normalize";
import { OverlayView } from "./OverlayView";
import { RunSelectList } from "./RunSelectList";
import { ScatterView } from "./ScatterView";
import { describeSetView, resolveSetView, type SetViewArgs } from "./setView";
import { TrendView } from "./TrendView";
import {
  type CadenceTrendData,
  MAX_COMPARE_RUNS,
  type OverlayRunStatus,
  type OverlayStreamData,
  type OverlayXMode,
  type RunStreamState,
  type ViewId,
} from "./types";
import { ZonesView } from "./ZonesView";

const NONE: ReadonlySet<string> = new Set();

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: "trend", label: "Trend" },
  { id: "scatter", label: "Scatter" },
  { id: "zones", label: "Zones" },
  { id: "overlay", label: "Overlay" },
];

interface AppProps {
  app: ReturnType<typeof useApp>["app"];
  data: CadenceTrendData;
  mode?: "mobile" | "desktop";
  viewToolRegistry?: ViewToolRegistry | null;
}

export function App({
  app,
  data,
  mode = "desktop",
  viewToolRegistry = null,
}: AppProps) {
  const isMobile = mode === "mobile";
  const [activeView, setActiveView] = useState<ViewId>("trend");
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  // Lifted out of the overlay so `set-view` can choose it as well as the pills.
  const [xMode, setXMode] = useState<OverlayXMode>("distance");
  // The overlay legend's switched-off runs, lifted so `set-view` can report
  // them and show a run again when the model selects it.
  const [hiddenRuns, setHiddenRuns] = useState<ReadonlySet<string>>(NONE);

  // Hidden runs belong to one visit to the overlay, as they did when the
  // overlay owned them: leaving it shows every run again next time.
  const showView = useCallback((view: ViewId) => {
    setActiveView(view);
    if (view !== "overlay") setHiddenRuns(NONE);
  }, []);

  const toggleHidden = useCallback((runId: string) => {
    setHiddenRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

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
        progress: entry.progress,
        noStreams: entry.data?.noStreams === true,
      });
    }
    return map;
  }, [data.activities, entries]);

  // Each selected run's place in the overlay, read the way the overlay
  // reads it, so the model is told only about lines that are drawn.
  const overlayStatus = useMemo(() => {
    const map = new Map<string, OverlayRunStatus>();
    for (const id of selectedRunIds) {
      map.set(id, overlayRunStatus(streams.get(id), hiddenRuns.has(id)));
    }
    return map;
  }, [selectedRunIds, streams, hiddenRuns]);

  // In selection order, so the context summary lists runs in the same order
  // the overlay colours them.
  const selectedRuns = useMemo(() => {
    const byId = new Map(data.activities.map((a) => [a.id, a]));
    return [...selectedRunIds].flatMap((id) => {
      const run = byId.get(id);
      return run ? [run] : [];
    });
  }, [data.activities, selectedRunIds]);

  // Runs the overlay can plot (it needs a cadence stream); the same pool the
  // Trend/Scatter dots draw from, offered as a keyboard/touch picker.
  const selectableRuns = useMemo(
    () => data.activities.filter((a) => a.averageCadence > 0),
    [data.activities],
  );

  const showRunPicker = activeView === "trend" || activeView === "scatter";

  /**
   * `set-view`: the model switches the view, chooses the runs to overlay, or
   * picks the overlay axis. Installed here rather than declared here (see
   * `viewToolDeclarations.ts`). `runIds` replaces the selection, in the order
   * given, so the overlay colours follow it, and shows any of those runs the
   * legend had hidden: the model asked to see them.
   */
  useViewTool(viewToolRegistry, "set-view", (args) => {
    const result = resolveSetView(
      args as SetViewArgs,
      data.activities,
      activeView,
    );
    if (result.kind === "error") return { text: result.text, isError: true };

    const chosen = new Set(result.runIds);
    const hiddenAfter = new Set(
      [...hiddenRuns].filter((id) => !chosen.has(id)),
    );
    const text = describeSetView(result, data.activities, {
      selectedRunIds,
      xAxis: xMode,
      runStatus: (id) => overlayRunStatus(streams.get(id), hiddenAfter.has(id)),
    });
    showView(result.view);
    if (result.runIds) {
      setSelectedRunIds(new Set(result.runIds));
      // Leaving the overlay has already shown every run again.
      if (result.view === "overlay" && hiddenAfter.size !== hiddenRuns.size) {
        setHiddenRuns(hiddenAfter);
      }
    }
    if (result.xAxis) setXMode(result.xAxis);
    return { text };
  });

  useModelContextSync(
    app ?? undefined,
    () =>
      buildCadenceContextSummary({
        weeks: data.weeks,
        activeView,
        selectedRuns,
        overlayAxis: xMode,
        overlayStatus,
        excludedNoCadence: data.excludedNoCadence,
        noPaceCount: data.noPaceCount,
      }),
    [
      data.weeks,
      activeView,
      selectedRuns,
      xMode,
      overlayStatus,
      data.excludedNoCadence,
      data.noPaceCount,
    ],
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
              onClick={() => showView(v.id)}
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
            xMode={xMode}
            onXModeChange={setXMode}
            hiddenRuns={hiddenRuns}
            onToggleHidden={toggleHidden}
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
