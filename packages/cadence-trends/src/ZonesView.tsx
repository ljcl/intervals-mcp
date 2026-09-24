import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { EmptyState } from "@intervals-mcp/ui";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildZonesA11y } from "./a11y";
import styles from "./chartView.module.css";
import { computeZoneStats } from "./normalize";
import { type RunSummary } from "./types";

interface ZonesViewProps {
  activities: RunSummary[];
  mode?: "mobile" | "desktop";
}

const ZONE_OPACITIES = [1, 0.8, 0.6, 0.4];

export function ZonesView({ activities, mode = "desktop" }: ZonesViewProps) {
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    marginRight: isMobile ? 8 : 16,
    marginLeft: isMobile ? -8 : 0,
    marginTop: isMobile ? 20 : 16,
    marginBottom: 24,
  };

  const zoneStats = useMemo(() => computeZoneStats(activities), [activities]);

  const chartData = useMemo(
    () =>
      zoneStats
        .filter((z) => z.count > 0)
        .map((z) => ({
          zone: z.zone.label,
          mean: z.mean,
          min: z.min,
          max: z.max,
          count: z.count,
          errorLow: z.mean - z.min,
          errorHigh: z.max - z.mean,
        })),
    [zoneStats],
  );

  const a11y = useMemo(() => buildZonesA11y(chartData), [chartData]);

  if (chartData.length === 0) {
    return <EmptyState>No runs with cadence data in this period.</EmptyState>;
  }

  return (
    <div className={styles.container}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
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
            dataKey="zone"
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border-secondary)" }}
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
          <Bar dataKey="mean" radius={[4, 4, 0, 0]}>
            {chartData.map((_, i) => (
              <Cell
                key={chartData[i]!.zone}
                fill="var(--chart-cadence)"
                fillOpacity={ZONE_OPACITIES[i] ?? 0.4}
              />
            ))}
            <ErrorBar
              dataKey="errorHigh"
              direction="y"
              width={tokens.errorBarWidth}
              stroke="var(--color-text-tertiary)"
              strokeWidth={1.5}
            />
            <LabelList
              dataKey="count"
              position="top"
              formatter={(v: string | number | boolean | null | undefined) =>
                `n=${v}`
              }
              style={{
                fontSize: tokens.labelFontSize,
                fill: "var(--color-text-tertiary)",
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
