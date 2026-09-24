import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildZonesA11y } from "./a11y";
import styles from "./chartView.module.css";
import { buildZoneRows } from "./normalize";
import { type ZoneSet } from "./types";
import { ZoneTooltip } from "./ZoneTooltip";

interface ZoneChartProps {
  set: ZoneSet;
  activityName: string;
  mode?: "mobile" | "desktop";
}

/** Z1 renders lightest, deeper zones darker — effort reads left to right. */
const ZONE_OPACITIES = [0.35, 0.5, 0.65, 0.8, 1];

const SET_COLORS: Record<ZoneSet["type"], string> = {
  heartrate: "var(--chart-heartrate)",
  power: "var(--chart-power)",
};

export function ZoneChart({
  set,
  activityName,
  mode = "desktop",
}: ZoneChartProps) {
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    marginRight: isMobile ? 8 : 16,
    marginLeft: isMobile ? -8 : 0,
    marginTop: isMobile ? 20 : 16,
    // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
    marginBottom: 24,
  };

  const rows = useMemo(() => buildZoneRows(set), [set]);
  const a11y = useMemo(
    () => buildZonesA11y(set, activityName),
    [set, activityName],
  );
  const color = SET_COLORS[set.type];
  const opacityFor = (index: number) =>
    ZONE_OPACITIES[
      Math.min(
        ZONE_OPACITIES.length - 1,
        Math.round(
          (index / Math.max(1, rows.length - 1)) * (ZONE_OPACITIES.length - 1),
        ),
      )
    ]!;

  return (
    <div className={styles.container}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
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
                    value: "min",
                    angle: -90,
                    position: "insideLeft",
                    style: {
                      fontSize: 11,
                      fill: "var(--color-text-tertiary)",
                    },
                  }
            }
          />
          <RechartsTooltip content={<ZoneTooltip color={color} />} />
          <Bar dataKey="minutes" radius={[4, 4, 0, 0]}>
            {rows.map((row, i) => (
              <Cell key={row.label} fill={color} fillOpacity={opacityFor(i)} />
            ))}
            <LabelList
              dataKey="pct"
              position="top"
              formatter={(v: string | number | boolean | null | undefined) =>
                `${v}%`
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
