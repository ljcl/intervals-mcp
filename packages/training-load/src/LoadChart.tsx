import { formatShortDate } from "@intervals-mcp/data";
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
import { type TrainingLoadData } from "./types";

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

  const chartData = useMemo(
    () =>
      weeks.map((week) => ({
        ...week,
        weekLabel: formatShortDate(week.weekStarting),
      })),
    [weeks],
  );

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
            width={isMobile ? 34 : 40}
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
            // would overshoot between a hard week and a rest week.
            <Line
              yAxisId="load"
              type="linear"
              dataKey="load"
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
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
