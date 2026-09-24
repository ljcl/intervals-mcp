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
import { type WeekSummary } from "./types";

interface LoadChartProps {
  weeks: WeekSummary[];
  /** Draw the rolling-average trend line. */
  showTrend: boolean;
  /** Highlight injury-risk weeks in the warning color. */
  showWarnings: boolean;
  mode?: "mobile" | "desktop";
}

export function LoadChart({
  weeks,
  showTrend,
  showWarnings,
  mode = "desktop",
}: LoadChartProps) {
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    marginRight: isMobile ? 8 : 16,
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
    () => buildLoadA11y(weeks, { showTrend, showWarnings }),
    [weeks, showTrend, showWarnings],
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
          <RechartsTooltip content={<LoadTooltip />} />
          <Bar dataKey="distanceKm" radius={[4, 4, 0, 0]}>
            {chartData.map((entry) => (
              <Cell
                key={entry.weekStarting}
                fill={
                  showWarnings && entry.warning
                    ? "var(--chart-heartrate)"
                    : "var(--chart-pace)"
                }
                fillOpacity={0.85}
              />
            ))}
          </Bar>
          {showTrend && (
            <Line
              type="monotone"
              dataKey="trendKm"
              stroke="var(--chart-cadence)"
              strokeWidth={tokens.strokeWidth}
              dot={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
