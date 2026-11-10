import { formatShortDate } from "@intervals-mcp/data";
import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildSeriesA11y } from "./a11y";
import styles from "./chartView.module.css";
import { chartedSeries, type SeriesSpec } from "./normalize";
import { type WellnessTrendData } from "./types";
import { WellnessTooltip } from "./WellnessTooltip";

interface WellnessChartProps {
  data: WellnessTrendData;
  mode?: "mobile" | "desktop";
}

/**
 * One panel per series, stacked on a shared date axis (synced cursor and
 * tooltip; ticks on the bottom panel only). Three units (ms, bpm, hours)
 * never share a y axis, so each panel scales to its own values. A day with
 * no record is a null point and `connectNulls` is off, so it is a gap.
 */
export function WellnessChart({ data, mode = "desktop" }: WellnessChartProps) {
  const series = useMemo(() => chartedSeries(data), [data]);
  return (
    <div className={styles.panels}>
      {series.map((spec, i) => (
        <SeriesPanel
          key={spec.key}
          data={data}
          spec={spec}
          showDates={i === series.length - 1}
          mode={mode}
        />
      ))}
    </div>
  );
}

interface SeriesPanelProps {
  data: WellnessTrendData;
  spec: SeriesSpec;
  showDates: boolean;
  mode: "mobile" | "desktop";
}

function SeriesPanel({ data, spec, showDates, mode }: SeriesPanelProps) {
  const isMobile = mode === "mobile";
  const tokens = getChartTokens(mode);
  const a11y = useMemo(() => buildSeriesA11y(data, spec), [data, spec]);
  const tick = {
    fontSize: tokens.axisFont,
    fill: "var(--color-text-tertiary)",
  };

  return (
    <div className={styles.panel} data-dates={showDates || undefined}>
      <span className={styles.panelLabel}>
        <span
          className={styles.swatch}
          style={{ backgroundColor: spec.color }}
        />
        {spec.label}, {spec.unit}
      </span>
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            accessibilityLayer
            title={a11y.title}
            desc={a11y.desc}
            data={data.points}
            syncId="wellness"
            // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
            // Room for the last date tick at the right, and for the half of
            // the lowest y tick that hangs below the plot.
            margin={{
              top: 8,
              right: isMobile ? 20 : 24,
              bottom: showDates ? 24 : 8,
              left: 0,
            }}
          >
            <CartesianGrid
              strokeDasharray={GRID_DASHARRAY}
              stroke="var(--color-border-tertiary)"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              hide={!showDates}
              tickFormatter={(date: string) => formatShortDate(date)}
              tick={tick}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border-secondary)" }}
              interval="preserveStartEnd"
              minTickGap={isMobile ? 40 : 28}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={tick}
              tickLine={false}
              axisLine={false}
              tickCount={3}
              width={isMobile ? 36 : 40}
            />
            <RechartsTooltip
              content={<WellnessTooltip data={data} spec={spec} />}
            />
            <Line
              type="linear"
              dataKey={spec.key}
              name={spec.label}
              stroke={spec.color}
              strokeWidth={tokens.strokeWidth}
              // A day between two gaps has no neighbour to draw a line to.
              dot={{ r: 2 * tokens.dotScale, fill: spec.color, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
