import { formatPace } from "@intervals-mcp/data";
import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { EmptyState } from "@intervals-mcp/ui";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Cell,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import { buildScatterA11y } from "./a11y";
import styles from "./chartView.module.css";
import { dotSize, linearRegression } from "./normalize";
import { SharedTooltip } from "./SharedTooltip";
import { type RunSummary } from "./types";

interface ScatterViewProps {
  activities: RunSummary[];
  onRunClick: (runId: number) => void;
  selectedRunIds: Set<number>;
  mode?: "mobile" | "desktop";
}

export function ScatterView({
  activities,
  onRunClick,
  selectedRunIds,
  mode = "desktop",
}: ScatterViewProps) {
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    marginRight: isMobile ? 8 : 16,
    marginLeft: isMobile ? -8 : 0,
    marginBottom: 24,
  };

  const runs = useMemo(
    () => activities.filter((a) => a.averageCadence > 0 && a.averagePace > 0),
    [activities],
  );

  const maxDistance = useMemo(
    () => Math.max(...runs.map((a) => a.distance), 1),
    [runs],
  );

  // Captured once per mount: "now" only anchors the recency opacity ramp,
  // and a fresh Date.now() each render invalidated the chartData memo on
  // every render.
  const [now] = useState(() => Date.now());
  const oldestTs = useMemo(
    () => Math.min(...runs.map((a) => new Date(a.date).getTime()), now),
    [runs, now],
  );
  const timeRange = now - oldestTs;

  const chartData = useMemo(
    () =>
      runs.map((a) => {
        const age = now - new Date(a.date).getTime();
        const recency = timeRange > 0 ? 1 - age / timeRange : 1;
        return {
          ...a,
          opacity: 0.3 + recency * 0.7,
          size: dotSize(a.distance, maxDistance) * tokens.dotScale,
        };
      }),
    [runs, maxDistance, now, timeRange, tokens.dotScale],
  );

  const regression = useMemo(() => {
    const points = runs.map((a) => ({ x: a.averagePace, y: a.averageCadence }));
    return linearRegression(points);
  }, [runs]);

  const a11y = useMemo(
    () => buildScatterA11y(runs, regression?.slope ?? null),
    [runs, regression],
  );

  if (chartData.length === 0) {
    return <EmptyState>No runs with cadence data in this period.</EmptyState>;
  }

  const paceExtent = [
    Math.min(...runs.map((a) => a.averagePace)),
    Math.max(...runs.map((a) => a.averagePace)),
  ];

  return (
    <div className={styles.container}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart
          accessibilityLayer
          title={a11y.title}
          desc={a11y.desc}
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
            dataKey="averagePace"
            type="number"
            reversed
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => formatPace(v)}
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border-secondary)" }}
            label={
              isMobile
                ? undefined
                : {
                    value: "Pace (min/km) \u2192 faster",
                    position: "insideBottom",
                    offset: -4,
                    style: {
                      fontSize: 11,
                      fill: "var(--color-text-tertiary)",
                    },
                  }
            }
          />
          <YAxis
            dataKey="averageCadence"
            type="number"
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
          <RechartsTooltip content={<SharedTooltip />} />
          {regression && (
            <ReferenceLine
              segment={[
                {
                  x: paceExtent[0],
                  y: regression.slope * paceExtent[0]! + regression.intercept,
                },
                {
                  x: paceExtent[1],
                  y: regression.slope * paceExtent[1]! + regression.intercept,
                },
              ]}
              stroke="var(--color-text-tertiary)"
              strokeDasharray="6 4"
              strokeWidth={1.5}
            />
          )}
          {/* Animation off: Recharts interpolates symbol size up from 0 and
              rekeys each symbol per frame, so for the ~400ms after mount the
              dots have no hit area and are remounted mid-click. Clicks in that
              window are silently dropped — for real users and for the play
              test alike. */}
          <Scatter
            data={chartData}
            fill="var(--chart-cadence)"
            isAnimationActive={false}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.id}
                cursor="pointer"
                fillOpacity={entry.opacity}
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
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
