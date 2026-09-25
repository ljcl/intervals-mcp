import { GRID_DASHARRAY, getChartTokens } from "@intervals-mcp/design-system";
import { EmptyState } from "@intervals-mcp/ui";
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip as RechartsTooltip,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildTrendA11y } from "./a11y";
import styles from "./chartView.module.css";
import {
  BAND_COLORS,
  buildChartRows,
  handoverLabel,
  hasRecordedLoad,
  isPlanned,
} from "./normalize";
import { TrendTooltip } from "./TrendTooltip";
import { type FitnessTrendData, type TrendBand } from "./types";

/** Dashes marking the forward half — plan or projection, never recorded. */
const PLAN_DASHARRAY = "5 4";

export interface TrendChartProps {
  data: FitnessTrendData;
  /** Draw the fitness (CTL) area. */
  showCtl: boolean;
  /** Draw the fatigue (ATL) line. */
  showAtl: boolean;
  /** Draw the form (TSB) line on the right axis. */
  showTsb: boolean;
  /** Draw the dashed forward half (taper plan, or rest projection). */
  showPlan: boolean;
  /**
   * Band kinds to leave unshaded. Kinds rather than a boolean because a window
   * can carry fatigue and ramp bands at once, and they read as one smear when
   * neither can be switched off.
   */
  hiddenBandKinds?: TrendBand["kind"][];
  mode?: "mobile" | "desktop";
}

export function TrendChart({
  data,
  showCtl,
  showAtl,
  showTsb,
  showPlan,
  hiddenBandKinds = [],
  mode = "desktop",
}: TrendChartProps) {
  const isMobile = mode === "mobile";
  const tokens = {
    ...getChartTokens(mode),
    marginRight: isMobile ? 4 : 8,
    // Two axes leave no room to pull in on mobile: a negative left margin
    // clips "100" to "0".
    marginLeft: 0,
    marginTop: 8,
    // Bottom margin must fit tick label descenders; see docs/mcp-apps.md.
    marginBottom: 24,
  };

  const rows = useMemo(() => buildChartRows(data), [data]);
  const a11y = useMemo(
    () =>
      buildTrendA11y(data, {
        showCtl,
        showAtl,
        showTsb,
        showPlan,
        hiddenBandKinds,
      }),
    [data, showCtl, showAtl, showTsb, showPlan, hiddenBandKinds],
  );
  const handover = handoverLabel(data);
  const planned = isPlanned(data);

  // Bands are dated; the axis is categorical, so each band maps to the axis
  // labels of the rows it covers.
  const bands = useMemo(() => {
    const labelByDate = new Map(rows.map((row) => [row.date, row.label]));
    return data.bands.flatMap((band) => {
      if (hiddenBandKinds.includes(band.kind)) return [];
      const x1 = labelByDate.get(band.startDate);
      const x2 = labelByDate.get(band.endDate);
      return x1 && x2 ? [{ ...band, x1, x2 }] : [];
    });
  }, [data.bands, rows, hiddenBandKinds]);

  if (!hasRecordedLoad(data)) {
    return (
      <EmptyState>
        No training load recorded in this window. CTL and ATL have nothing to
        build from yet.
      </EmptyState>
    );
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
            minTickGap={isMobile ? 40 : 28}
          />
          <YAxis
            yAxisId="load"
            domain={[0, "auto"]}
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={false}
            width={isMobile ? 36 : 40}
            label={
              isMobile
                ? undefined
                : {
                    value: "CTL / ATL",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 11, fill: "var(--color-text-tertiary)" },
                  }
            }
          />
          <YAxis
            yAxisId="form"
            orientation="right"
            tick={{
              fontSize: tokens.axisFont,
              fill: "var(--color-text-tertiary)",
            }}
            tickLine={false}
            axisLine={false}
            width={isMobile ? 32 : 38}
            hide={!showTsb}
            label={
              isMobile
                ? undefined
                : {
                    value: "TSB",
                    angle: 90,
                    position: "insideRight",
                    style: { fontSize: 11, fill: "var(--color-text-tertiary)" },
                  }
            }
          />

          {bands.map((band) => (
            <ReferenceArea
              key={`${band.kind}-${band.startDate}`}
              yAxisId="load"
              x1={band.x1}
              x2={band.x2}
              fill={BAND_COLORS[band.kind]}
              fillOpacity={0.12}
              ifOverflow="extendDomain"
            />
          ))}

          {showTsb && (
            <ReferenceLine
              yAxisId="form"
              y={0}
              stroke="var(--chart-grade)"
              strokeDasharray={GRID_DASHARRAY}
            />
          )}
          {showPlan && handover && rows.length > data.series.length && (
            <ReferenceLine
              yAxisId="load"
              x={handover}
              stroke="var(--color-border-primary)"
              strokeDasharray={PLAN_DASHARRAY}
              label={{
                value: planned ? "plan" : "rest",
                position: "insideTopRight",
                style: { fontSize: 10, fill: "var(--color-text-tertiary)" },
              }}
            />
          )}

          <RechartsTooltip content={<TrendTooltip planned={planned} />} />

          {showCtl && (
            <Area
              yAxisId="load"
              type="monotone"
              dataKey="ctl"
              name="Fitness"
              stroke="var(--chart-pace)"
              strokeWidth={tokens.strokeWidth}
              fill="var(--chart-pace)"
              fillOpacity={0.16}
              dot={false}
              connectNulls={false}
            />
          )}
          {showAtl && (
            <Line
              yAxisId="load"
              type="monotone"
              dataKey="atl"
              name="Fatigue"
              stroke="var(--chart-heartrate)"
              strokeWidth={tokens.secondaryStrokeWidth}
              dot={false}
              connectNulls={false}
            />
          )}
          {showTsb && (
            <Line
              yAxisId="form"
              type="monotone"
              dataKey="tsb"
              name="Form"
              stroke="var(--chart-power)"
              strokeWidth={tokens.secondaryStrokeWidth}
              dot={false}
              connectNulls={false}
            />
          )}

          {showPlan && showCtl && (
            <Line
              yAxisId="load"
              type="monotone"
              dataKey="planCtl"
              name="Fitness (plan)"
              stroke="var(--chart-pace)"
              strokeWidth={tokens.strokeWidth}
              strokeDasharray={PLAN_DASHARRAY}
              dot={false}
              connectNulls={false}
            />
          )}
          {showPlan && showAtl && (
            <Line
              yAxisId="load"
              type="monotone"
              dataKey="planAtl"
              name="Fatigue (plan)"
              stroke="var(--chart-heartrate)"
              strokeWidth={tokens.secondaryStrokeWidth}
              strokeDasharray={PLAN_DASHARRAY}
              dot={false}
              connectNulls={false}
            />
          )}
          {showPlan && showTsb && (
            <Line
              yAxisId="form"
              type="monotone"
              dataKey="planTsb"
              name="Form (plan)"
              stroke="var(--chart-power)"
              strokeWidth={tokens.secondaryStrokeWidth}
              strokeDasharray={PLAN_DASHARRAY}
              dot={false}
              connectNulls={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
