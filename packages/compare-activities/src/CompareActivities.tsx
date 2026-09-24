import { formatPace, formatTime } from "@intervals-mcp/data";
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
} from "@intervals-mcp/ui";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { buildCompareA11yDescription, buildCompareA11yTitle } from "./a11y";
import {
  alignedKey,
  alignSeries,
  type PaceCategory,
  paceCategory,
  paceMetricLabel,
  paceMetricUnit,
  sharedAxes,
  sharedMetrics,
  toMetricSeries,
} from "./align";
import styles from "./CompareActivities.module.css";
import { buildCompareContextSummary } from "./contextSummary";
import {
  type ActivityStreamData,
  type AxisKey,
  type CompareData,
  type MetricKey,
} from "./types";

/** Activity 1 = blue, activity 2 = orange: a colorblind-safe category pair. */
const COLOR_A = "var(--chart-pace)";
const COLOR_B = "var(--chart-cadence)";

function metricLabel(metric: MetricKey, category: PaceCategory): string {
  switch (metric) {
    case "pace":
      return paceMetricLabel(category);
    case "heartrate":
      return "Heart Rate";
    case "power":
      return "Power";
    case "cadence":
      return "Cadence";
    case "altitude":
      return "Altitude";
  }
}

function metricUnit(
  metric: MetricKey,
  category: PaceCategory,
  bothRunning: boolean,
): string {
  switch (metric) {
    case "pace":
      return paceMetricUnit(category);
    case "heartrate":
      return "bpm";
    case "power":
      return "W";
    case "cadence":
      return bothRunning ? "spm" : "rpm";
    case "altitude":
      return "m";
  }
}

function formatMetricValue(
  value: number,
  metric: MetricKey,
  category: PaceCategory,
): string {
  if (metric === "pace" && category !== "speed") return formatPace(value);
  if (metric === "heartrate" || metric === "cadence") {
    return String(Math.round(value));
  }
  return value.toFixed(1);
}

/** Km ticks for the distance axis (streams carry metres). */
function formatKm(metres: number): string {
  const km = metres / 1000;
  return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10}km`;
}

/* ── Tooltip ──────────────────────────────────────────────────── */

interface TooltipPayloadEntry {
  dataKey: string;
  name: string;
  value: number | null;
  color: string;
}

interface CompareTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: number;
  metric: MetricKey;
  category: PaceCategory;
  bothRunning: boolean;
  axis: AxisKey;
}

export function CompareTooltip({
  active,
  payload,
  label,
  metric,
  category,
  bothRunning,
  axis,
}: CompareTooltipProps) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter(
    (e): e is TooltipPayloadEntry & { value: number } => e.value != null,
  );
  if (!entries.length) return null;

  const unit = metricUnit(metric, category, bothRunning);
  const aEntry = entries.find((e) => e.dataKey === alignedKey("a", metric));
  const bEntry = entries.find((e) => e.dataKey === alignedKey("b", metric));

  // Δ = activity 2 − activity 1 at this point. Pace deltas read best in
  // seconds; everything else in the metric's own unit.
  let delta: { value: string; unit: string } | null = null;
  if (aEntry && bEntry) {
    const diff = bEntry.value - aEntry.value;
    delta =
      metric === "pace" && category !== "speed"
        ? {
            value: `${diff > 0 ? "+" : ""}${Math.round(diff * 60)}`,
            unit: `s ${unit}`,
          }
        : {
            value: `${diff > 0 ? "+" : ""}${
              metric === "heartrate" || metric === "cadence"
                ? Math.round(diff)
                : diff.toFixed(1)
            }`,
            unit,
          };
  }

  return (
    <UiTooltip
      timestamp={
        axis === "distance" ? formatKm(label ?? 0) : formatTime(label ?? 0)
      }
    >
      {entries.map((entry) => (
        <TooltipEntry
          key={entry.dataKey}
          color={entry.color}
          label={entry.name}
          value={formatMetricValue(entry.value, metric, category)}
          unit={unit}
        />
      ))}
      {delta && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label="Δ 2−1"
          value={delta.value}
          unit={delta.unit}
        />
      )}
    </UiTooltip>
  );
}

/* ── Delta summary bar ────────────────────────────────────────── */

interface DeltaTile {
  key: string;
  label: string;
  a: string;
  b: string;
  delta: string;
  /** Colors the delta: better = success, worse = danger. */
  trend?: "better" | "worse";
}

function signed(value: number, digits = 0): string {
  const rounded = digits === 0 ? Math.round(value) : value.toFixed(digits);
  return `${value > 0 ? "+" : ""}${rounded}`;
}

export function buildDeltaTiles(compare: CompareData): DeltaTile[] {
  const { activity_1: a1, activity_2: a2, differences, efficiency } = compare;
  const tiles: DeltaTile[] = [
    {
      key: "distance",
      label: "Distance",
      a: `${a1.distance_km}km`,
      b: `${a2.distance_km}km`,
      delta: `${signed(differences.distance_km, 2)}km`,
    },
    {
      key: "time",
      label: "Time",
      a: formatTime(a1.moving_time),
      b: formatTime(a2.moving_time),
      delta: "",
    },
  ];

  if (a1.pace_min_per_km && a2.pace_min_per_km && differences.pace) {
    tiles.push({
      key: "pace",
      label: "Pace",
      a: a1.pace_min_per_km,
      b: a2.pace_min_per_km,
      delta: `${differences.pace.min_per_km}/km`,
      trend:
        differences.pace.interpretation === "faster"
          ? "better"
          : differences.pace.interpretation === "slower"
            ? "worse"
            : undefined,
    });
  }
  if (
    a1.average_hr != null &&
    a2.average_hr != null &&
    differences.avg_hr != null
  ) {
    tiles.push({
      key: "hr",
      label: "Avg HR",
      a: `${a1.average_hr}`,
      b: `${a2.average_hr}`,
      delta: `${signed(differences.avg_hr)}bpm`,
    });
  }
  if (
    a1.cadence_spm != null &&
    a2.cadence_spm != null &&
    differences.cadence_spm != null
  ) {
    tiles.push({
      key: "cadence",
      label: "Cadence",
      a: `${a1.cadence_spm}`,
      b: `${a2.cadence_spm}`,
      delta: `${signed(differences.cadence_spm)}spm`,
    });
  }
  tiles.push({
    key: "elevation",
    label: "Elevation",
    a: `${Math.round(a1.elevation_gain_m)}m`,
    b: `${Math.round(a2.elevation_gain_m)}m`,
    delta: `${signed(differences.elevation_gain_m)}m`,
  });
  if (efficiency) {
    tiles.push({
      key: "efficiency",
      label: "Efficiency",
      a: efficiency.activity_1.toFixed(2),
      b: efficiency.activity_2.toFixed(2),
      delta: `${signed(efficiency.change_percent, 1)}%`,
      trend:
        efficiency.interpretation === "improved"
          ? "better"
          : efficiency.interpretation === "declined"
            ? "worse"
            : undefined,
    });
  }
  return tiles;
}

/* ── Main view ────────────────────────────────────────────────── */

interface CompareActivitiesProps {
  a: ActivityStreamData;
  b: ActivityStreamData;
  /** Aggregate summary; the overlay still renders without it. */
  compare: CompareData | null;
  mode?: "mobile" | "desktop";
  app?: ModelContextApp;
}

export function CompareActivities({
  a,
  b,
  compare,
  mode = "desktop",
  app,
}: CompareActivitiesProps) {
  const isMobile = mode === "mobile";
  const isCompact = isMobile;
  const tokens = useMemo(
    () => ({
      ...getChartTokens(mode),
      marginRight: 12,
      marginLeft: isMobile ? -14 : -8,
      marginTop: isMobile ? 8 : 5,
      // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
      marginBottom: 24,
    }),
    [mode, isMobile],
  );

  const category = paceCategory(a.activityType, b.activityType);
  const bothRunning = category === "run";

  const seriesA = useMemo(() => toMetricSeries(a, category), [a, category]);
  const seriesB = useMemo(() => toMetricSeries(b, category), [b, category]);
  const metrics = useMemo(
    () => sharedMetrics(seriesA, seriesB),
    [seriesA, seriesB],
  );
  const axes = useMemo(() => sharedAxes(seriesA, seriesB), [seriesA, seriesB]);

  const [metric, setMetric] = useState<MetricKey | null>(metrics[0] ?? null);
  const [axis, setAxis] = useState<AxisKey>(axes[0] ?? "time");
  const [hidden, setHidden] = useState<{ a: boolean; b: boolean }>({
    a: false,
    b: false,
  });

  const aligned = useMemo(
    () => alignSeries(seriesA, seriesB, axis),
    [seriesA, seriesB, axis],
  );

  useModelContextSync(
    app,
    () =>
      buildCompareContextSummary({
        compare,
        metric,
        axis,
        paceLabel: category === "speed" ? "speed" : undefined,
      }),
    [compare, metric, axis, category],
  );

  const tiles = useMemo(
    () => (compare ? buildDeltaTiles(compare) : []),
    [compare],
  );

  const toggleLine = (side: "a" | "b") =>
    setHidden((prev) => ({ ...prev, [side]: !prev[side] }));

  // Screen-reader narration, computed outside the chart memo so the
  // memo's dependency is the resulting string.
  const a11yDescription = useMemo(
    () =>
      metric
        ? buildCompareA11yDescription({
            nameA: a.name,
            nameB: b.name,
            metric,
            axis,
            category,
            bothRunning,
            data: aligned,
            hidden,
          })
        : "",
    [a.name, b.name, metric, axis, category, bothRunning, aligned, hidden],
  );

  const chart = useMemo(() => {
    if (!metric || aligned.length === 0) return null;
    const reversed = metric === "pace" && category !== "speed";
    return (
      <ResponsiveContainer width="100%" aspect={tokens.chartAspect}>
        <ComposedChart
          accessibilityLayer
          title={buildCompareA11yTitle(a.name, b.name)}
          desc={a11yDescription}
          data={aligned}
          margin={{
            top: tokens.marginTop,
            right: tokens.marginRight,
            bottom: tokens.marginBottom,
            left: tokens.marginLeft,
          }}
        >
          <CartesianGrid
            horizontal={true}
            vertical={false}
            strokeDasharray={GRID_DASHARRAY}
            stroke="var(--color-border-tertiary)"
          />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, "dataMax"]}
            tickFormatter={axis === "distance" ? formatKm : formatTime}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            interval="preserveStartEnd"
            minTickGap={40}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={["auto", "auto"]}
            reversed={reversed}
            stroke="var(--color-text-tertiary)"
            fontSize={tokens.axisFont}
            tickCount={isMobile ? 4 : 5}
            tickFormatter={(v: number) =>
              metric === "pace" && category !== "speed"
                ? formatPace(v)
                : String(Math.round(v))
            }
            axisLine={false}
            tickLine={false}
            width={isMobile ? 42 : 48}
          />
          <Tooltip
            content={
              <CompareTooltip
                metric={metric}
                category={category}
                bothRunning={bothRunning}
                axis={axis}
              />
            }
            isAnimationActive={false}
            allowEscapeViewBox={{ x: false, y: false }}
            wrapperStyle={{ pointerEvents: "none", zIndex: 10 }}
          />
          {!hidden.a && (
            <Line
              type="monotone"
              dataKey={alignedKey("a", metric)}
              name={a.name}
              stroke={COLOR_A}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls
            />
          )}
          {!hidden.b && (
            <Line
              type="monotone"
              dataKey={alignedKey("b", metric)}
              name={b.name}
              stroke={COLOR_B}
              dot={false}
              strokeWidth={tokens.strokeWidth}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }, [
    aligned,
    metric,
    axis,
    category,
    bothRunning,
    hidden,
    isMobile,
    tokens,
    a.name,
    b.name,
    a11yDescription,
  ]);

  const subtitle = compare
    ? `${compare.activity_1.date} vs ${compare.activity_2.date} · ${compare.activity_2.type}`
    : b.activityType;

  return (
    <div
      className={styles.compareActivities}
      data-compact={isCompact || undefined}
    >
      <CardHeader
        title={
          <>
            {a.name} <span className={styles.vs}>vs</span> {b.name}
          </>
        }
        subtitle={subtitle}
        compact={isCompact}
      />

      {tiles.length > 0 && (
        <div className={styles.deltaBar}>
          {tiles.map((tile) => (
            <div key={tile.key} className={styles.tile}>
              <div className={styles.tileLabel}>{tile.label}</div>
              <div className={styles.tileValues}>
                <span className={styles.tileA}>{tile.a}</span>
                <span className={styles.tileArrow}>→</span>
                <span className={styles.tileB}>{tile.b}</span>
              </div>
              {tile.delta && (
                <div className={styles.tileDelta} data-trend={tile.trend}>
                  {tile.delta}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {compare?.warnings?.length ? (
        <div className={styles.warning}>{compare.warnings.join(" ")}</div>
      ) : null}

      {chart ? (
        <div className={styles.chartArea}>{chart}</div>
      ) : (
        <EmptyState>
          These activities have no overlapping streams to overlay.
        </EmptyState>
      )}

      <div className={styles.footer}>
        <div className={styles.footerControls}>
          {metrics.length > 1 && (
            <PillGroup>
              {metrics.map((key) => (
                <Pill
                  key={key}
                  active={key === metric}
                  onClick={() => setMetric(key)}
                >
                  {metricLabel(key, category)}
                </Pill>
              ))}
            </PillGroup>
          )}
          {axes.length > 1 && (
            <PillGroup>
              {axes.map((key) => (
                <Pill
                  key={key}
                  active={key === axis}
                  onClick={() => setAxis(key)}
                >
                  {key === "distance" ? "Distance" : "Time"}
                </Pill>
              ))}
            </PillGroup>
          )}
        </div>
        <Legend size={tokens.legendSize}>
          <LegendItem
            color={COLOR_A}
            label={a.name}
            hidden={hidden.a}
            onClick={() => toggleLine("a")}
          />
          <LegendItem
            color={COLOR_B}
            label={b.name}
            hidden={hidden.b}
            onClick={() => toggleLine("b")}
          />
        </Legend>
      </div>
    </div>
  );
}
