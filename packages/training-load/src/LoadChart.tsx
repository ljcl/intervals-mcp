import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { EmptyState } from "@intervals-mcp/ui";
import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildLoadA11y } from "./a11y";
import styles from "./chartView.module.css";
import { LoadTooltip } from "./LoadTooltip";
import { buildLoadRows } from "./normalize";
import { type TrainingLoadData } from "./types";

/**
 * The right axis lists load ticks from the axis line outward, so its title
 * needs a gutter of its own past the widest tick or it lands on the ticks.
 * Tick width is estimated from the tick font (a digit is about 0.62em) for
 * four digits, so a 1,000+ load still clears the title.
 */
const LOAD_TICK_CHARS = 4;
const DIGIT_EM = 0.62;
/** The rotated title (about 13px), its inset from the edge, and a gap. */
const LOAD_TITLE_GUTTER = 24;

/** The "This week so far" fill, as on the legend key and the partial bar. */
const PARTIAL_FILL = "color-mix(in srgb, var(--chart-power) 35%, transparent)";

interface LoadChartProps {
  data: TrainingLoadData;
  /** Draw the rolling-average trend line. */
  showTrend: boolean;
  /** Highlight volume-spike weeks in the warning color. */
  showWarnings: boolean;
  /** Draw weekly training load as a line on its own right-hand axis. */
  showLoad: boolean;
  mode?: "mobile" | "desktop";
}

export function LoadChart({
  data,
  showTrend,
  showWarnings,
  showLoad,
  mode = "desktop",
}: LoadChartProps) {
  const { weeks } = data;
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    // The load axis sits on the right and carries its own width, so the
    // margin only needs to keep its last tick off the card edge.
    marginRight: isMobile ? 4 : 8,
    marginLeft: isMobile ? -8 : 0,
    marginTop: 8,
    // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
    marginBottom: 24,
  };

  const loadAxisWidth =
    Math.ceil(LOAD_TICK_CHARS * DIGIT_EM * tokens.axisFont) +
    (isMobile ? 0 : LOAD_TITLE_GUTTER);

  const chartData = useMemo(() => buildLoadRows(weeks), [weeks]);
  const hasWeekInProgress = chartData.some((row) => row.inProgress);

  const a11y = useMemo(
    () => buildLoadA11y(data, { showTrend, showWarnings, showLoad }),
    [data, showTrend, showWarnings, showLoad],
  );

  if (chartData.length === 0) {
    return <EmptyState>No runs in this period.</EmptyState>;
  }

  return (
    <div className={styles.container}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          accessibilityLayer
          title={a11y.title}
          desc={a11y.desc}
          data={chartData}
          margin={{
            top: tokens.marginTop,
            right: tokens.marginRight,
            bottom: tokens.marginBottom,
            left: tokens.marginLeft,
          }}
        >
          <CartesianGrid
            yAxisId="distance"
            strokeDasharray={GRID_DASHARRAY}
            stroke="var(--color-border-tertiary)"
            vertical={false}
          />
          <XAxis
            dataKey="weekLabel"
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border-secondary)" }}
            interval={isMobile ? "preserveStartEnd" : "preserveEnd"}
            minTickGap={isMobile ? 32 : 20}
          />
          <YAxis
            yAxisId="distance"
            domain={[0, "auto"]}
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
                    value: "km",
                    angle: -90,
                    position: "insideLeft",
                    style: {
                      fontSize: 11,
                      fill: "var(--color-text-tertiary)",
                    },
                  }
            }
          />
          {/* Load is on its own scale: a hard week's load is in the hundreds
           * against a few tens of km, and sharing an axis would flatten one
           * of them. The axis hides with the line so the plot widens back. */}
          <YAxis
            yAxisId="load"
            orientation="right"
            domain={[0, "auto"]}
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={false}
            width={loadAxisWidth}
            hide={!showLoad}
            label={
              isMobile
                ? undefined
                : {
                    value: "Load",
                    angle: 90,
                    position: "insideRight",
                    style: {
                      fontSize: 11,
                      fill: "var(--color-text-tertiary)",
                    },
                  }
            }
          />
          <RechartsTooltip content={<LoadTooltip />} />
          <Bar yAxisId="distance" dataKey="distanceKm" radius={[4, 4, 0, 0]}>
            {chartData.map((entry) => {
              const fill =
                showWarnings && entry.warning
                  ? "var(--chart-heartrate)"
                  : "var(--chart-pace)";
              // The week in progress holds only the days so far: a light,
              // dashed bar, so it does not read as a drop in volume.
              return (
                <Cell
                  key={entry.weekStarting}
                  fill={fill}
                  fillOpacity={entry.inProgress ? 0.35 : 0.85}
                  stroke={entry.inProgress ? fill : undefined}
                  strokeDasharray={entry.inProgress ? "3 2" : undefined}
                />
              );
            })}
          </Bar>
          {showTrend && (
            <Line
              yAxisId="distance"
              type="monotone"
              dataKey="trendKm"
              stroke="var(--chart-cadence)"
              strokeWidth={tokens.strokeWidth}
              dot={false}
            />
          )}
          {showLoad && (
            // Linear, not a spline: weeks are discrete points, and a curve
            // would overshoot between a hard week and a rest week. Complete
            // weeks only: the week in progress is drawn apart, below.
            <Line
              yAxisId="load"
              type="linear"
              dataKey="loadComplete"
              stroke="var(--chart-power)"
              strokeWidth={tokens.secondaryStrokeWidth}
              dot={{
                r: 2.5 * tokens.dotScale,
                fill: "var(--chart-power)",
                stroke: "var(--chart-power)",
              }}
              activeDot={{ r: 4 * tokens.dotScale }}
            />
          )}
          {showLoad && hasWeekInProgress && (
            // The week in progress holds only the days so far, so its load is
            // a hollow point beside the light dashed bar, not the line's last
            // point plunging. A line with one point draws no stroke, only its
            // dot, and none is wanted (`stroke="none"`: the dot carries its
            // own colors).
            <Line
              yAxisId="load"
              type="linear"
              dataKey="loadSoFar"
              stroke="none"
              dot={{
                r: 3.5 * tokens.dotScale,
                fill: PARTIAL_FILL,
                stroke: "var(--chart-power)",
                strokeWidth: 1.5,
              }}
              activeDot={{
                r: 4.5 * tokens.dotScale,
                fill: PARTIAL_FILL,
                stroke: "var(--chart-power)",
                strokeWidth: 1.5,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
