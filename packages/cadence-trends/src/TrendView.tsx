import { formatShortDate } from "@intervals-mcp/data";
import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { EmptyState } from "@intervals-mcp/ui";
import { useMemo } from "react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Scatter,
  XAxis,
  YAxis,
} from "recharts";
import { buildTrendA11y } from "./a11y";
import styles from "./chartView.module.css";
import { dotSize, rollingAverage } from "./normalize";
import { SharedTooltip } from "./SharedTooltip";
import { type RunSummary } from "./types";

interface TrendViewProps {
  activities: RunSummary[];
  onRunClick: (runId: string) => void;
  selectedRunIds: Set<string>;
  mode?: "mobile" | "desktop";
}

export function TrendView({
  activities,
  onRunClick,
  selectedRunIds,
  mode = "desktop",
}: TrendViewProps) {
  const isMobile = mode === "mobile";
  const chartTokens = getChartTokens(mode);
  const tokens = {
    ...chartTokens,
    marginRight: isMobile ? 8 : 16,
    marginLeft: isMobile ? -8 : 0,
    // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
    marginBottom: 24,
    // Alias for call-site clarity.
    trendStrokeWidth: chartTokens.strokeWidth,
  };

  const sorted = useMemo(
    () =>
      [...activities]
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .filter((a) => a.averageCadence > 0),
    [activities],
  );

  const maxDistance = useMemo(
    () => Math.max(...sorted.map((a) => a.distance), 1),
    [sorted],
  );

  const trend = useMemo(() => rollingAverage(sorted, 5), [sorted]);

  const chartData = useMemo(
    () =>
      sorted.map((a, i) => ({
        ...a,
        dateFormatted: formatShortDate(a.date),
        dateTs: new Date(a.date).getTime(),
        trendCadence: trend[i]?.cadence ?? null,
        size: dotSize(a.distance, maxDistance) * tokens.dotScale,
      })),
    [sorted, trend, maxDistance, tokens.dotScale],
  );

  const a11y = useMemo(() => buildTrendA11y(sorted), [sorted]);

  if (chartData.length === 0) {
    return <EmptyState>No runs with cadence data in this period.</EmptyState>;
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
            dataKey="dateFormatted"
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
            yAxisId="cadence"
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
          <YAxis
            yAxisId="pace"
            orientation="right"
            reversed
            domain={["auto", "auto"]}
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={false}
            width={isMobile ? 34 : 44}
            label={
              isMobile
                ? undefined
                : {
                    value: "min/km",
                    angle: 90,
                    position: "insideRight",
                    style: {
                      fontSize: 11,
                      fill: "var(--color-text-tertiary)",
                    },
                  }
            }
          />
          <RechartsTooltip content={<SharedTooltip />} />
          <Line
            yAxisId="cadence"
            type="monotone"
            dataKey="trendCadence"
            stroke="var(--chart-cadence)"
            strokeWidth={tokens.trendStrokeWidth}
            dot={false}
            connectNulls
            strokeOpacity={0.5}
          />
          {/* Animation off on both scatters: Recharts interpolates symbol
              size up from 0 and rekeys each symbol per frame, so for the
              ~400ms after mount the dots have no hit area and are remounted
              mid-click. Clicks in that window are silently dropped — for real
              users and for the play test alike. */}
          <Scatter
            yAxisId="cadence"
            dataKey="averageCadence"
            fill="var(--chart-cadence)"
            isAnimationActive={false}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.id}
                cursor="pointer"
                r={entry.size / 2}
                stroke={
                  selectedRunIds.has(entry.id)
                    ? "var(--color-text-primary)"
                    : "none"
                }
                strokeWidth={selectedRunIds.has(entry.id) ? 2 : 0}
                onClick={() => onRunClick(entry.id)}
              />
            ))}
          </Scatter>
          <Scatter
            yAxisId="pace"
            dataKey="averagePace"
            fill="var(--chart-pace)"
            fillOpacity={0.5}
            isAnimationActive={false}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.id}
                cursor="pointer"
                r={Math.max(entry.size / 2 - 1, 2)}
                onClick={() => onRunClick(entry.id)}
              />
            ))}
          </Scatter>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
