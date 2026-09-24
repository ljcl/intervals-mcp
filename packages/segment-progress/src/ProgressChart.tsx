import { formatClock } from "@intervals-mcp/data";
import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { EmptyState } from "@intervals-mcp/ui";
import { type ReactNode, useCallback, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  type DotItemDotProps,
  Line,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildProgressA11y } from "./a11y";
import styles from "./chartView.module.css";
import { buildChartRows, type ChartRow } from "./normalize";
import { ProgressTooltip } from "./ProgressTooltip";
import {
  type ProgressSummary,
  type SegmentEffort,
  type SegmentSummary,
} from "./types";

interface ProgressChartProps {
  segment: SegmentSummary;
  efforts: SegmentEffort[];
  summary: ProgressSummary;
  /** Draw the average heart-rate overlay on the right axis. */
  showHeartrate: boolean;
  mode?: "mobile" | "desktop";
}

/** Breathing room around the time series, as a share of its span. */
const TIME_PAD_RATIO = 0.08;
/** Minimum padding so a flat series is not drawn as a line on the axis. */
const MIN_TIME_PAD_SECONDS = 5;

/** Achievement colours, shared with the effort list and route-map halos. */
const HIGHLIGHT_FILL = {
  best: "var(--color-tier-pr)",
  top: "var(--color-tier-top10)",
} as const;

export function ProgressChart({
  segment,
  efforts,
  summary,
  showHeartrate,
  mode = "desktop",
}: ProgressChartProps) {
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    // Clock tick labels are wider than plain numbers, and the last date
    // label needs room past the plot when there is no right-hand axis.
    marginRight: isMobile ? 12 : 20,
    marginLeft: 0,
    marginTop: 8,
    // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
    marginBottom: 24,
  };

  const rows = useMemo(() => buildChartRows(efforts), [efforts]);
  const a11y = useMemo(
    () => buildProgressA11y(segment, summary, showHeartrate),
    [segment, summary, showHeartrate],
  );

  const timeDomain = useMemo((): [number, number] => {
    if (rows.length === 0) return [0, 1];
    const times = rows.map((row) => row.elapsedSeconds);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const pad = Math.max((max - min) * TIME_PAD_RATIO, MIN_TIME_PAD_SECONDS);
    return [Math.max(0, min - pad), max + pad];
  }, [rows]);

  const heartrateVisible =
    showHeartrate && rows.some((row) => row.averageHeartrate != null);

  /**
   * One dot per effort, painted by its highlight tier. A custom renderer
   * rather than extra Scatter series: Scatter draws a symbol for every row
   * of the data, including the ones whose value is null, so the highlights
   * would come with phantom points attached.
   */
  const renderDot = useCallback(
    ({ cx, cy, index, payload }: DotItemDotProps): ReactNode => {
      if (cx == null || cy == null) return null;
      const highlight = (payload as ChartRow | undefined)?.highlight ?? null;
      const radius = (highlight ? 4.5 : 3) * tokens.dotScale;
      return (
        <circle
          key={`dot-${index}`}
          cx={cx}
          cy={cy}
          r={radius}
          fill={highlight ? HIGHLIGHT_FILL[highlight] : "var(--chart-pace)"}
          stroke={highlight ? "var(--color-background-primary)" : "none"}
          strokeWidth={highlight ? 1.5 : 0}
        />
      );
    },
    [tokens.dotScale],
  );

  if (rows.length === 0) {
    return <EmptyState>No efforts on this segment yet.</EmptyState>;
  }

  return (
    <div className={styles.container}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          accessibilityLayer
          title={a11y.title}
          desc={a11y.desc}
          data={rows}
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
            dataKey="label"
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border-secondary)" }}
            interval="preserveStartEnd"
            minTickGap={isMobile ? 32 : 20}
          />
          {/* Reversed: a faster effort sits higher, so improvement reads up. */}
          <YAxis
            yAxisId="time"
            reversed
            domain={timeDomain}
            tickFormatter={(value: number) => formatClock(value)}
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={false}
            width={isMobile ? 44 : 52}
            label={
              isMobile
                ? undefined
                : {
                    value: "time (faster ↑)",
                    angle: -90,
                    position: "insideLeft",
                    style: {
                      fontSize: 11,
                      fill: "var(--color-text-tertiary)",
                    },
                  }
            }
          />
          {heartrateVisible && (
            <YAxis
              yAxisId="hr"
              orientation="right"
              domain={["dataMin - 4", "dataMax + 4"]}
              tick={{
                fontSize: tokens.axisFont,
                fill: "var(--chart-heartrate)",
              }}
              tickLine={false}
              axisLine={false}
              width={isMobile ? 30 : 36}
            />
          )}
          <RechartsTooltip
            content={
              <ProgressTooltip
                activityType={segment.activityType}
                bestSeconds={summary.bestSeconds}
              />
            }
          />
          {/* Straight segments, not a smoothed curve: efforts are weeks
              apart, and a spline would invent times between them. */}
          <Line
            yAxisId="time"
            type="linear"
            dataKey="elapsedSeconds"
            stroke="var(--chart-pace)"
            strokeWidth={tokens.strokeWidth}
            dot={renderDot}
            activeDot={{ r: 5 * tokens.dotScale }}
            isAnimationActive={false}
          />
          {heartrateVisible && (
            <Line
              yAxisId="hr"
              type="linear"
              dataKey="averageHeartrate"
              stroke="var(--chart-heartrate)"
              strokeWidth={tokens.secondaryStrokeWidth}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
