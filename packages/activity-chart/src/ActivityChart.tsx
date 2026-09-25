import { formatDistance, formatPace, formatTime } from "@intervals-mcp/data";
import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import {
  CardHeader,
  EmptyState,
  Legend,
  LegendItem,
  type ModelContextApp,
  Pill,
  PillGroup,
  TooltipEntry,
  Tooltip as UiTooltip,
  useModelContextSync,
  useViewTool,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styles from "./ActivityChart.module.css";
import { buildChartA11yDescription, buildChartA11yTitle } from "./a11y";
import { describeZoomWindow, indexRangeForValues } from "./brushWindow";
import { buildChartContextSummary } from "./contextSummary";
import { selectLapLabels } from "./lapLabels";
import { type ChartLap, smoothData } from "./normalize";
import {
  type ActivityMeta,
  type ChartDataPoint,
  type MetricKey,
} from "./types";

const COLORS = {
  altitude: "var(--chart-altitude)",
  cadence: "var(--chart-cadence)",
  grade: "var(--chart-grade)",
  heartrate: "var(--chart-heartrate)",
  pace: "var(--chart-pace)",
  power: "var(--chart-power)",
};

const ALL_METRICS: MetricKey[] = [
  "heartrate",
  "power",
  "pace",
  "altitude",
  "cadence",
  "grade",
];

/* ── Preset system ────────────────────────────────────────────── */

interface ViewPreset {
  id: string;
  label: string;
  metrics: MetricKey[];
  /** All of these must be available for the preset to show */
  requires: MetricKey[];
}

const RUNNING_PRESETS: ViewPreset[] = [
  {
    id: "effort",
    label: "Effort",
    metrics: ["heartrate", "pace", "altitude"],
    requires: ["heartrate"],
  },
  {
    id: "power",
    label: "Power",
    metrics: ["power", "pace", "altitude"],
    requires: ["power"],
  },
  {
    id: "form",
    label: "Form",
    metrics: ["cadence", "pace", "heartrate"],
    requires: ["cadence"],
  },
  {
    id: "terrain",
    label: "Terrain",
    metrics: ["altitude", "grade", "pace"],
    requires: ["altitude", "grade"],
  },
  { id: "all", label: "All", metrics: ALL_METRICS, requires: [] },
];

const CYCLING_PRESETS: ViewPreset[] = [
  {
    id: "effort",
    label: "Effort",
    metrics: ["power", "heartrate", "altitude"],
    requires: ["heartrate"],
  },
  {
    id: "speed",
    label: "Speed",
    metrics: ["pace", "heartrate", "altitude"],
    requires: ["pace"],
  },
  {
    id: "form",
    label: "Form",
    metrics: ["cadence", "power", "heartrate"],
    requires: ["cadence"],
  },
  {
    id: "terrain",
    label: "Terrain",
    metrics: ["altitude", "grade", "pace"],
    requires: ["altitude", "grade"],
  },
  { id: "all", label: "All", metrics: ALL_METRICS, requires: [] },
];

const SWIMMING_PRESETS: ViewPreset[] = [
  {
    id: "effort",
    label: "Effort",
    metrics: ["heartrate", "pace"],
    requires: ["heartrate"],
  },
  { id: "all", label: "All", metrics: ALL_METRICS, requires: [] },
];

function getAvailablePresets(
  meta: ActivityMeta,
  availableMetrics: Set<MetricKey>,
): ViewPreset[] {
  const base = meta.isRunning
    ? RUNNING_PRESETS
    : meta.isSwimming
      ? SWIMMING_PRESETS
      : CYCLING_PRESETS;
  return base.filter((p) => p.requires.every((k) => availableMetrics.has(k)));
}

function computeHiddenSet(
  preset: ViewPreset,
  availableMetrics: Set<MetricKey>,
): Set<string> {
  const hidden = new Set<string>();
  for (const key of availableMetrics) {
    if (!preset.metrics.includes(key)) hidden.add(key);
  }
  return hidden;
}

/**
 * Per-series class names for the CSS legend-hover dimming: hover
 * state is applied as a `data-hovered` attribute on the chart wrapper and
 * resolved in CSS, so hovering the legend never re-renders the memoized
 * Recharts tree.
 */
const SERIES_CLASS: Record<MetricKey, string> = {
  heartrate: `${styles.series} ${styles.seriesHeartrate}`,
  power: `${styles.series} ${styles.seriesPower}`,
  pace: `${styles.series} ${styles.seriesPace}`,
  altitude: `${styles.series} ${styles.seriesAltitude}`,
  cadence: `${styles.series} ${styles.seriesCadence}`,
  grade: `${styles.series} ${styles.seriesGrade}`,
};

/* ── PresetSelector component ─────────────────────────────────── */

interface PresetSelectorProps {
  presets: ViewPreset[];
  activePresetId: string | null;
  onSelect: (preset: ViewPreset) => void;
}

function PresetSelector({
  presets,
  activePresetId,
  onSelect,
}: PresetSelectorProps) {
  if (presets.length <= 1) return null;
  return (
    <PillGroup>
      {presets.map((preset) => (
        <Pill
          key={preset.id}
          active={preset.id === activePresetId}
          onClick={() => onSelect(preset)}
        >
          {preset.label}
        </Pill>
      ))}
    </PillGroup>
  );
}

/* ── Tooltip ──────────────────────────────────────────────────── */

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number | null; color: string }>;
  label?: number;
  meta: ActivityMeta;
  xIsDistance?: boolean;
}

export function ChartTooltip({
  active,
  payload,
  label,
  meta,
  xIsDistance,
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  // Keep zeros: 0 W (coasting), 0% grade, and cadence 0 are real readings.
  const filtered = payload.filter(
    (e): e is { name: string; value: number; color: string } => e.value != null,
  );
  if (!filtered.length) return null;

  const paceUnit = meta.isRunning
    ? "min/km"
    : meta.isSwimming
      ? "/100m"
      : "km/h";

  const unitMap: Record<string, string> = {
    Altitude: "m",
    Cadence: meta.isRunning ? "spm" : "rpm",
    Grade: "%",
    "Heart Rate": "bpm",
    Pace: paceUnit,
    Power: "W",
  };

  const timestamp = xIsDistance
    ? formatDistance(label ?? 0)
    : formatTime(label ?? 0);

  return (
    <UiTooltip timestamp={timestamp}>
      {filtered.map((entry) => (
        <TooltipEntry
          key={entry.name}
          color={entry.color}
          label={entry.name}
          value={
            entry.name === "Pace" && (meta.isRunning || meta.isSwimming)
              ? formatPace(entry.value)
              : entry.value.toFixed(1)
          }
          unit={unitMap[entry.name]}
        />
      ))}
    </UiTooltip>
  );
}

/* ── Legend items ─────────────────────────────────────────────── */

interface LegendEntry {
  key: string;
  color: string;
  label: string;
}

/* ── Main chart ───────────────────────────────────────────────── */

interface ActivityChartProps {
  data: ChartDataPoint[];
  meta: ActivityMeta;
  laps?: ChartLap[];
  mode?: "mobile" | "desktop";
  app?: ModelContextApp;
  /** Where `set-brush-window`'s implementation is installed. */
  viewToolRegistry?: ViewToolRegistry | null;
}

export function ActivityChart({
  data,
  meta,
  laps,
  mode = "desktop",
  viewToolRegistry = null,
  app,
}: ActivityChartProps) {
  const isMobile = mode === "mobile";
  // Compact flag used by the CSS module for header/footer spacing.
  const isCompact = isMobile;
  const tokens = useMemo(() => {
    const chartTokens = getChartTokens(mode);
    return {
      ...chartTokens,
      // Alias for the cadence overlay; it's the secondary stroke semantically.
      cadenceStrokeWidth: chartTokens.secondaryStrokeWidth,
      // activity-chart is a hero chart and reclaims YAxis space with negative outer margin.
      chartMarginX: isMobile ? -20 : -30,
      // Slight top margin to separate the header from the chart plot area.
      chartMarginTop: isMobile ? 8 : 5,
    };
  }, [mode, isMobile]);

  // Which series have data — one memoized scan instead of six per render.
  const availableMetrics = useMemo(() => {
    const s = new Set<MetricKey>();
    for (const metric of ALL_METRICS) {
      // != null: a metric that is present but null (gap) at every sample has
      // no data to show, same as never having recorded it at all.
      if (data.some((d) => d[metric] != null)) s.add(metric);
    }
    return s;
  }, [data]);

  const presets = useMemo(
    () => getAvailablePresets(meta, availableMetrics),
    [meta, availableMetrics],
  );

  // Initialize hidden from the default "Effort" preset
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const defaultPreset = presets.find((p) => p.id === "effort") ?? presets[0];
    return defaultPreset
      ? computeHiddenSet(defaultPreset, availableMetrics)
      : new Set();
  });

  const [hoveredLegendKey, setHoveredLegendKey] = useState<string | null>(null);
  // Mobile defaults to smoothed because the Smooth toggle is hidden there —
  // the raw traces are too noisy to read at small sizes anyway.
  const [smooth, setSmooth] = useState(isMobile);

  // X-axis brush window. Controlled so the zoom survives preset,
  // legend, and smooth toggles (those rebuild the memoized tree, and an
  // uncontrolled Brush would reset to the full range). Indexes stay valid
  // across the Smooth toggle because smoothing preserves point count.
  const [zoomRange, setZoomRange] = useState<{
    startIndex?: number;
    endIndex?: number;
  }>({});

  /**
   * `set-brush-window`: the model zooms the chart to the part of the
   * run under discussion — "the surge in the last km" — instead of asking the
   * user to drag the handles there. Installed rather than declared here: the
   * tool is registered before `connect()`, long before this component mounts.
   *
   * It writes the same controlled `zoomRange` the handles do, so a
   * model-driven zoom survives preset, legend, and smooth toggles exactly as
   * a dragged one does.
   */
  useViewTool(viewToolRegistry, "set-brush-window", (args) => {
    if (args.reset === true) {
      setZoomRange({});
      return { text: `Showing all of ${meta.name}.` };
    }

    const byDistance =
      args.fromKm !== undefined || args.toKm !== undefined || meta.isSwimming;
    const values = byDistance
      ? data.map((p) => p.distance)
      : data.map((p) => p.time);

    if (byDistance && values.every((v) => v === undefined)) {
      return {
        text: "This activity has no distance stream, so the chart can only be zoomed by time (fromSeconds / toSeconds).",
        isError: true,
      };
    }

    const scale = byDistance ? 1000 : 1;
    const lo = byDistance ? args.fromKm : args.fromSeconds;
    const hi = byDistance ? args.toKm : args.toSeconds;
    const first = values.find((v) => v !== undefined) ?? 0;
    const last = [...values].reverse().find((v) => v !== undefined) ?? 0;

    const range = indexRangeForValues(
      values,
      typeof lo === "number" ? lo * scale : first,
      typeof hi === "number" ? hi * scale : last,
    );
    if (!range) {
      const unit = byDistance ? "km" : "s";
      const extent = byDistance ? (last / 1000).toFixed(1) : String(last);
      return {
        text: `That window is outside this activity, which runs to ${extent} ${unit}.`,
        isError: true,
      };
    }

    setZoomRange(range);
    const shown = byDistance
      ? `${((values[range.startIndex] ?? 0) / 1000).toFixed(2)}–${((values[range.endIndex] ?? 0) / 1000).toFixed(2)} km`
      : `${formatTime(values[range.startIndex] ?? 0)}–${formatTime(values[range.endIndex] ?? 0)}`;
    return { text: `Zoomed the chart to ${shown} of ${meta.name}.` };
  });

  useModelContextSync(
    app,
    () =>
      buildChartContextSummary({
        activityName: meta.name,
        availableMetrics: [...availableMetrics],
        hidden,
        smooth,
        zoomWindow: describeZoomWindow(
          data,
          meta.isSwimming === true,
          zoomRange,
          formatTime,
        ),
      }),
    [meta, hidden, smooth, availableMetrics, data, zoomRange],
  );

  const displayData = useMemo(
    () => (smooth ? smoothData(data) : data),
    [data, smooth],
  );

  // Rendered plot width, used to decide how many lap/segment band labels fit
  // without overlapping. Bucketed so minor reflows don't churn the memoized
  // chart tree; starts at a mode-based estimate so labels are sensible
  // before the observer fires (and in non-DOM renders).
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(isMobile ? 340 : 720);
  useEffect(() => {
    const el = chartAreaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // Ignore implausibly small transient measurements (pre-layout ticks) so
      // a rounding artifact never zeroes the width and drops every label.
      if (w < 24) return;
      const bucketed = Math.round(w / 24) * 24;
      setPlotWidth((prev) => (prev === bucketed ? prev : bucketed));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Bands drawn behind the chart (skip zero-width swim rests at the wall).
  const bandLaps = useMemo(
    () =>
      (laps ?? []).filter(
        (lap) => !(meta.isSwimming && lap.startDistance === lap.endDistance),
      ),
    [laps, meta.isSwimming],
  );

  // Derive active preset by matching current hidden state
  const activePresetId = useMemo(() => {
    for (const preset of presets) {
      const presetHidden = computeHiddenSet(preset, availableMetrics);
      if (
        presetHidden.size === hidden.size &&
        [...presetHidden].every((k) => hidden.has(k))
      ) {
        return preset.id;
      }
    }
    return null;
  }, [presets, hidden, availableMetrics]);

  const handlePresetSelect = (preset: ViewPreset) => {
    setHidden(computeHiddenSet(preset, availableMetrics));
  };

  const toggle = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const legendItems: LegendEntry[] = [];
  if (availableMetrics.has("heartrate"))
    legendItems.push({
      key: "heartrate",
      color: COLORS.heartrate,
      label: "Heart Rate",
    });
  if (availableMetrics.has("power"))
    legendItems.push({ key: "power", color: COLORS.power, label: "Power" });
  if (availableMetrics.has("pace"))
    legendItems.push({
      key: "pace",
      color: COLORS.pace,
      label: meta.isRunning ? "Pace" : "Speed",
    });
  if (availableMetrics.has("altitude"))
    legendItems.push({
      key: "altitude",
      color: COLORS.altitude,
      label: "Altitude",
    });
  if (availableMetrics.has("cadence"))
    legendItems.push({
      key: "cadence",
      color: COLORS.cadence,
      label: "Cadence",
    });
  if (availableMetrics.has("grade") && !isMobile)
    legendItems.push({ key: "grade", color: COLORS.grade, label: "Grade" });

  // Screen-reader narration, computed outside the chart memo so the
  // memo's dependency is the resulting string, not the smoothing flag.
  const a11yDescription = useMemo(() => {
    const drawn = (key: MetricKey) =>
      availableMetrics.has(key) &&
      !hidden.has(key) &&
      (key !== "grade" || !isMobile);
    return buildChartA11yDescription({
      meta,
      data: displayData,
      visibleMetrics: ALL_METRICS.filter(drawn),
      // Recorded but deliberately not drawn at this size: without
      // this the same activity reads as having different data on mobile.
      omittedMetrics:
        isMobile && availableMetrics.has("grade") && !hidden.has("grade")
          ? ["grade"]
          : [],
      lapCount:
        laps?.filter(
          (lap) => !(meta.isSwimming && lap.startDistance === lap.endDistance),
        ).length ?? 0,
      smoothed: smooth,
    });
  }, [meta, displayData, availableMetrics, hidden, isMobile, laps, smooth]);

  // The Recharts tree is memoized WITHOUT the hover state: hovering the
  // legend only flips a data attribute on the wrapper div (dimming is CSS),
  // so the element below stays referentially stable and React bails out of
  // re-rendering the chart over per-second stream data.
  const chart = useMemo(() => {
    const show = (key: MetricKey) =>
      availableMetrics.has(key) && !hidden.has(key);

    // Band-label overlap avoidance: decide which lap/segment labels fit
    // against the currently visible axis window (full range, or the brush
    // zoom slice) so a dense run of short bands doesn't stack labels.
    const getStart = (l: ChartLap) =>
      meta.isSwimming ? l.startDistance : l.startTime;
    const getEnd = (l: ChartLap) =>
      meta.isSwimming ? l.endDistance : l.endTime;
    const xKey = meta.isSwimming ? "distance" : "time";
    const startIdx = zoomRange.startIndex ?? 0;
    const endIdx = zoomRange.endIndex ?? displayData.length - 1;
    const fallbackMin = bandLaps.length ? getStart(bandLaps[0]!) : 0;
    const fallbackMax = bandLaps.length
      ? getEnd(bandLaps[bandLaps.length - 1]!)
      : 0;
    const visibleMin =
      (displayData[startIdx]?.[xKey] as number | undefined) ?? fallbackMin;
    const visibleMax =
      (displayData[endIdx]?.[xKey] as number | undefined) ?? fallbackMax;
    const labelFlags = selectLapLabels(
      bandLaps.map((lap) => ({
        name: lap.name,
        start: getStart(lap),
        end: getEnd(lap),
      })),
      visibleMin,
      visibleMax,
      plotWidth,
    );

    return (
      <ResponsiveContainer width="100%" aspect={tokens.chartAspect}>
        <ComposedChart
          accessibilityLayer
          title={buildChartA11yTitle(meta)}
          desc={a11yDescription}
          data={displayData}
          margin={{
            bottom: 5,
            left: tokens.chartMarginX,
            right: tokens.chartMarginX,
            top: tokens.chartMarginTop,
          }}
        >
          <defs>
            <linearGradient id="gradAltitude" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.altitude} stopOpacity={0.2} />
              <stop
                offset="100%"
                stopColor={COLORS.altitude}
                stopOpacity={0.03}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            horizontal={true}
            vertical={false}
            strokeDasharray={GRID_DASHARRAY}
            stroke="var(--color-border-tertiary)"
          />
          <XAxis
            dataKey={meta.isSwimming ? "distance" : "time"}
            tickFormatter={meta.isSwimming ? formatDistance : formatTime}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            interval="preserveStartEnd"
            minTickGap={40}
            axisLine={false}
            tickLine={false}
          />
          {/* Left Y-axis: HR / Power / Cadence */}
          <YAxis
            yAxisId="left"
            domain={["auto", "auto"]}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={isMobile ? 4 : 5}
            axisLine={false}
            tickLine={false}
          />
          {/* Right Y-axis: Altitude (floor at 0 for real-world proportions) */}
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, "auto"]}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={isMobile ? 4 : 5}
            axisLine={false}
            tickLine={false}
          />
          {/* Hidden Y-axis for pace/speed — independent scaling */}
          <YAxis
            yAxisId="pace"
            hide
            domain={["auto", "auto"]}
            reversed={meta.isRunning || meta.isSwimming}
          />
          <Tooltip
            content={<ChartTooltip meta={meta} xIsDistance={meta.isSwimming} />}
            isAnimationActive={false}
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ pointerEvents: "none", zIndex: 10 }}
          />
          {/* Lap bands */}
          {bandLaps.map((lap, i) => {
            const label = labelFlags[i] ? lap.name : "";

            return (
              <ReferenceArea
                key={`lap-${lap.name}-${getStart(lap)}`}
                yAxisId="left"
                x1={getStart(lap)}
                x2={getEnd(lap)}
                fill={
                  lap.isRest
                    ? "var(--color-border-tertiary)"
                    : i % 2 === 0
                      ? "var(--chart-pace)"
                      : "transparent"
                }
                fillOpacity={lap.isRest ? 0.3 : 0.06}
                stroke="none"
                label={{
                  value: label,
                  position: "insideTopLeft",
                  style: {
                    fontSize: 10,
                    fill: "var(--color-text-tertiary)",
                    fontFamily: "var(--font-sans)",
                  },
                }}
              />
            );
          })}

          {/* Altitude area fill */}
          {show("altitude") && (
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="altitude"
              className={SERIES_CLASS.altitude}
              fill="url(#gradAltitude)"
              stroke={COLORS.altitude}
              strokeWidth={1}
              connectNulls={false}
              name="Altitude"
              fillOpacity={0.25}
            />
          )}

          {/* Heart rate */}
          {show("heartrate") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="heartrate"
              name="Heart Rate"
              className={SERIES_CLASS.heartrate}
              stroke={COLORS.heartrate}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls={false}
            />
          )}

          {/* Power */}
          {show("power") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="power"
              name="Power"
              className={SERIES_CLASS.power}
              stroke={COLORS.power}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls={false}
            />
          )}

          {/* Pace / Speed */}
          {show("pace") && (
            <Line
              yAxisId="pace"
              type="monotone"
              dataKey="pace"
              name="Pace"
              className={SERIES_CLASS.pace}
              stroke={COLORS.pace}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls={false}
            />
          )}

          {/* Cadence */}
          {show("cadence") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="cadence"
              name="Cadence"
              className={SERIES_CLASS.cadence}
              stroke={COLORS.cadence}
              dot={false}
              strokeWidth={tokens.cadenceStrokeWidth}
              connectNulls={false}
            />
          )}

          {/* Grade — hidden on mobile because it crowds the altitude
              axis and its info value is low at a glance */}
          {!isMobile && show("grade") && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="grade"
              name="Grade"
              className={SERIES_CLASS.grade}
              stroke={COLORS.grade}
              dot={false}
              strokeWidth={1}
              connectNulls={false}
            />
          )}

          {/* X-axis zoom window: drag the handles (touch works) to zoom
              into a segment; overlays and the tooltip follow. */}
          <Brush
            className={styles.brush}
            dataKey={meta.isSwimming ? "distance" : "time"}
            tickFormatter={meta.isSwimming ? formatDistance : formatTime}
            height={isMobile ? 26 : 20}
            travellerWidth={isMobile ? 12 : 8}
            startIndex={zoomRange.startIndex}
            endIndex={zoomRange.endIndex}
            onChange={(range) =>
              setZoomRange({
                startIndex: range.startIndex,
                endIndex: range.endIndex,
              })
            }
            stroke="var(--color-border-secondary)"
            fill="transparent"
          />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }, [
    displayData,
    tokens,
    meta,
    bandLaps,
    plotWidth,
    isMobile,
    availableMetrics,
    hidden,
    a11yDescription,
    zoomRange,
  ]);

  // Manual entries, treadmill uploads, and activities with device data
  // stripped parse into a valid-but-plottable-nothing payload. Without this
  // guard the card renders bare axes, an empty legend, and an empty preset
  // selector, which reads as a broken app rather than "nothing to chart".
  // Placed after the hooks above so the branch cannot reorder them.
  if (data.length === 0 || availableMetrics.size === 0) {
    return (
      <div
        className={styles.activityChart}
        data-compact={isCompact || undefined}
      >
        <CardHeader
          title={meta.name}
          subtitle={meta.activityType}
          compact={isCompact}
        />
        <EmptyState>
          This activity has no recorded streams, so there is nothing to chart.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.activityChart} data-compact={isCompact || undefined}>
      <CardHeader
        title={meta.name}
        subtitle={meta.activityType}
        compact={isCompact}
      />

      <div
        ref={chartAreaRef}
        className={styles.chartArea}
        data-hovered={hoveredLegendKey ?? undefined}
      >
        {chart}
      </div>

      {/* Footer: presets + smooth (left) | legend (right) */}
      <div className={styles.footer}>
        <div className={styles.footerControls}>
          <PresetSelector
            presets={presets}
            activePresetId={activePresetId}
            onSelect={handlePresetSelect}
          />
          {/* Smooth toggle only on desktop — mobile defaults to smoothed
              and hides the control to save footer width */}
          {!isMobile && (
            <PillGroup>
              <Pill active={smooth} onClick={() => setSmooth((s) => !s)}>
                Smooth
              </Pill>
            </PillGroup>
          )}
        </div>
        <Legend size={tokens.legendSize}>
          {legendItems.map(({ key, color, label }) => (
            <LegendItem
              key={key}
              color={color}
              label={label}
              hidden={hidden.has(key)}
              onClick={() => toggle(key)}
              onMouseEnter={() => setHoveredLegendKey(key)}
              onMouseLeave={() => setHoveredLegendKey(null)}
              // Same setter on focus/blur: tabbing the legend isolates
              // the series exactly as hovering it does.
              onFocus={() => setHoveredLegendKey(key)}
              onBlur={() => setHoveredLegendKey(null)}
            />
          ))}
        </Legend>
      </div>
    </div>
  );
}
