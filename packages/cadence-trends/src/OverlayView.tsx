import { formatShortDate } from "@intervals-mcp/data";
import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import {
  EmptyState,
  ErrorState,
  Legend,
  LegendItem,
  LoadingState,
  Pill,
  PillGroup,
  Skeleton,
  TooltipEntry,
  Tooltip as UiTooltip,
} from "@intervals-mcp/ui";
import { useEffect, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildOverlayA11y } from "./a11y";
import {
  assignOverlayColors,
  overlayRunLabel,
  overlayRunStatus,
  resampleOverlayRuns,
} from "./normalize";
import styles from "./OverlayView.module.css";
import {
  type OverlayPoint,
  type OverlayXMode,
  type RunStreamState,
  type RunSummary,
} from "./types";

interface OverlayViewProps {
  selectedRunIds: Set<string>;
  /** Per-run stream state; a run absent from the map is not yet requested. */
  streams: Map<string, RunStreamState>;
  requestStream: (runId: string) => void;
  retryStream: (runId: string) => void;
  /** Owned by the app, so the model can set it as well as the pills. */
  xMode: OverlayXMode;
  onXModeChange: (xMode: OverlayXMode) => void;
  /** Runs the legend has switched off. Owned by the app, so `set-view` can
   * report them and show a run again when the model selects it. */
  hiddenRuns: ReadonlySet<string>;
  onToggleHidden: (runId: string) => void;
  mode?: "mobile" | "desktop";
}

interface OverlayTooltipProps {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    name?: string;
    value?: number | null;
    color?: string;
  }>;
  label?: number | string;
  xMode: OverlayXMode;
}

/**
 * Themed tooltip matching SharedTooltip in the Trend/Scatter views — the
 * default Recharts tooltip is a hardcoded white box, unreadable in dark
 * mode. One entry per visible run at the hovered grid point.
 */
function OverlayTooltip({
  active,
  payload,
  label,
  xMode,
}: OverlayTooltipProps) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter((e) => e.value != null);
  if (!entries.length) return null;

  const x = Number(label);
  const timestamp =
    xMode === "distance" ? `${x.toFixed(1)} km` : `${x.toFixed(0)} min`;

  return (
    <UiTooltip timestamp={timestamp}>
      {entries.map((entry) => (
        <TooltipEntry
          key={String(entry.dataKey ?? entry.name)}
          color={entry.color ?? "var(--chart-cadence)"}
          label={entry.name ?? ""}
          value={`${Math.round(entry.value!)}`}
          unit="spm"
        />
      ))}
    </UiTooltip>
  );
}

export function OverlayView({
  selectedRunIds,
  streams,
  requestStream,
  retryStream,
  xMode,
  onXModeChange,
  hiddenRuns,
  onToggleHidden,
  mode = "desktop",
}: OverlayViewProps) {
  const isMobile = mode === "mobile";
  const chartTokens = getChartTokens(mode);
  const tokens = {
    ...chartTokens,
    marginRight: isMobile ? 8 : 16,
    marginLeft: isMobile ? -8 : 0,
    marginBottom: 24,
    // OverlayView stacks many streams; use the lighter secondary stroke.
    strokeWidth: chartTokens.secondaryStrokeWidth,
  };

  // Request every selected run. The fetcher is idempotent per key and never
  // re-fires a failed one, so this effect cannot loop on a failure.
  useEffect(() => {
    for (const id of selectedRunIds) requestStream(id);
  }, [selectedRunIds, requestStream]);

  // Colours follow selection order, fixed before any stream has loaded, so a
  // run never changes colour as the others arrive.
  const colors = useMemo(
    () => assignOverlayColors(selectedRunIds),
    [selectedRunIds],
  );

  // The selected runs the overlay knows about, in selection order. A run
  // with no stream state yet cannot be named, and is not shown.
  const selectedRuns = useMemo(
    () =>
      [...selectedRunIds].flatMap((id) => {
        const run = streams.get(id)?.run;
        return run ? [run] : [];
      }),
    [selectedRunIds, streams],
  );

  const runs = useMemo(() => {
    const entries: Array<{
      run: RunSummary;
      points: OverlayPoint[];
      color: string;
      label: string;
    }> = [];
    for (const id of selectedRunIds) {
      const state = streams.get(id);
      // A stream-less run has nothing to draw: it is named in a note below.
      // The legend's hidden runs stay here: their line is drawn hidden.
      if (state?.points && overlayRunStatus(state, false) === "drawn") {
        entries.push({
          run: state.run,
          points: state.points,
          color: colors.get(id)!,
          label: overlayRunLabel(state.run, selectedRuns),
        });
      }
    }
    return entries;
  }, [selectedRunIds, streams, colors, selectedRuns]);

  const failed = useMemo(
    () =>
      [...selectedRunIds]
        .map((id) => streams.get(id))
        .filter(
          (state): state is RunStreamState =>
            overlayRunStatus(state, false) === "failed",
        ),
    [selectedRunIds, streams],
  );

  // Selected runs that loaded but recorded no streams, in selection order.
  // Not a failure: a retry cannot succeed, so they get a note, not a retry.
  const streamless = useMemo(
    () =>
      [...selectedRunIds].flatMap((id) => {
        const state = streams.get(id);
        return state && overlayRunStatus(state, false) === "noStreams"
          ? [state.run]
          : [];
      }),
    [selectedRunIds, streams],
  );

  // Resample every run onto a shared x grid so runs at different speeds
  // stay aligned and shorter runs end at their own extent.
  const { chartData, runKeys } = useMemo(() => {
    if (runs.length === 0) return { chartData: [], runKeys: [] as string[] };
    return {
      chartData: resampleOverlayRuns(
        runs.map((r) => ({ id: r.run.id, points: r.points })),
        xMode,
      ),
      runKeys: runs.map((r) => `cadence_${r.run.id}`),
    };
  }, [runs, xMode]);

  const a11y = useMemo(
    () =>
      buildOverlayA11y(
        runs.map((r) => ({ name: r.run.name, date: r.run.date })),
        xMode,
      ),
    [runs, xMode],
  );

  // A selected run with no entry yet counts as loading: the request effect
  // has not run for it, and a bare axis frame for one frame reads as a bug.
  const isLoading = [...selectedRunIds].some(
    (id) => overlayRunStatus(streams.get(id), false) === "loading",
  );
  // The latest progress line of the first selected run that is still loading.
  const progress =
    [...selectedRunIds]
      .map((id) => streams.get(id))
      .find((state) => state?.loading && state.progress)?.progress ?? null;

  if (selectedRunIds.size === 0) {
    return (
      <EmptyState>
        Click runs in Trend or Scatter view to compare them here
      </EmptyState>
    );
  }

  const failureMessage =
    failed.length === 1
      ? `Could not load stream data for ${overlayRunLabel(failed[0]!.run, selectedRuns)}.`
      : `Could not load stream data for ${failed.length} of the selected runs.`;
  const retryFailed = () => {
    for (const state of failed) retryStream(state.run.id);
  };

  // Every selected run is stream-less: nothing is loading or failed either,
  // since a run only becomes stream-less once its fetch has succeeded.
  if (streamless.length === selectedRunIds.size) {
    return (
      <EmptyState>
        None of the selected runs has recorded streams to overlay.
      </EmptyState>
    );
  }

  const streamlessNotes = streamless.map((run) => (
    <p key={run.id} className={styles.note}>
      No recorded streams for {overlayRunLabel(run, selectedRuns)}.
    </p>
  ));

  // Nothing to draw yet — replace the chart rather than framing empty axes.
  if (runs.length === 0 && isLoading) {
    return (
      <LoadingState label="Loading stream data" progress={progress}>
        <Skeleton variant="chart" />
      </LoadingState>
    );
  }
  if (runs.length === 0 && failed.length > 0) {
    return (
      <div>
        <ErrorState message={failureMessage} onRetry={retryFailed} />
        {streamlessNotes}
      </div>
    );
  }

  return (
    <div>
      {isLoading && (
        <LoadingState label="Loading stream data" progress={progress}>
          {/* Visible echo of the status label; the region announces once. */}
          <div className={styles.loading} aria-hidden="true">
            Loading stream data...
          </div>
        </LoadingState>
      )}
      {/* A failed run stays visible in the overlay: a console.error alone
          leaves the athlete with no signal. */}
      {failed.length > 0 && (
        <ErrorState message={failureMessage} onRetry={retryFailed} />
      )}
      {streamlessNotes}
      <div className={styles.container}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            accessibilityLayer
            title={a11y.title}
            desc={a11y.desc}
            data={chartData}
            margin={{
              top: 8,
              right: tokens.marginRight,
              bottom: tokens.marginBottom,
              left: tokens.marginLeft,
            }}
          >
            <CartesianGrid
              strokeDasharray={GRID_DASHARRAY}
              stroke="var(--color-border-tertiary)"
            />
            <XAxis
              dataKey="x"
              type="number"
              domain={["auto", "auto"]}
              tick={{
                fontSize: tokens.axisFont,
                fill: "var(--color-text-tertiary)",
              }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border-secondary)" }}
              label={
                isMobile
                  ? undefined
                  : {
                      value: xMode === "distance" ? "km" : "min",
                      position: "insideBottomRight",
                      offset: -4,
                      style: {
                        fontSize: tokens.axisFont,
                        fill: "var(--color-text-tertiary)",
                      },
                    }
              }
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{
                fontSize: tokens.axisFont,
                fill: "var(--color-text-tertiary)",
              }}
              tickLine={false}
              axisLine={false}
              width={isMobile ? 34 : 40}
              label={
                isMobile
                  ? undefined
                  : {
                      value: "spm",
                      angle: -90,
                      position: "insideLeft",
                      style: {
                        fontSize: 11,
                        fill: "var(--color-text-tertiary)",
                      },
                    }
              }
            />
            <RechartsTooltip content={<OverlayTooltip xMode={xMode} />} />
            {runs.map((r, i) => (
              <Line
                key={r.run.id}
                type="monotone"
                dataKey={runKeys[i]}
                stroke={r.color}
                strokeWidth={tokens.strokeWidth}
                dot={false}
                hide={hiddenRuns.has(r.run.id)}
                name={r.label}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className={styles.footer}>
        <PillGroup>
          <Pill
            active={xMode === "distance"}
            onClick={() => onXModeChange("distance")}
          >
            km
          </Pill>
          <Pill active={xMode === "time"} onClick={() => onXModeChange("time")}>
            min
          </Pill>
        </PillGroup>
        <Legend size={isMobile ? "touch" : "default"}>
          {runs.map((r) => {
            const label = isMobile
              ? r.label
              : `${r.run.name} · ${formatShortDate(r.run.date, "short")}`;
            return (
              <LegendItem
                key={r.run.id}
                color={r.color}
                label={label}
                hidden={hiddenRuns.has(r.run.id)}
                onClick={() => onToggleHidden(r.run.id)}
              />
            );
          })}
        </Legend>
      </div>
    </div>
  );
}
