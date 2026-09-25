import { formatShortDate } from "@intervals-mcp/data";
import { type SummaryStat } from "@intervals-mcp/ui";
import {
  type FitnessTrendData,
  type TaperPlan,
  type TrendBand,
  type TrendDay,
} from "./types";

/** "+12" / "-4" / "0" — form only reads correctly with its sign. */
export function signedTsb(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * One chart row per date. Recorded days carry `ctl`/`atl`/`tsb`; projected
 * days carry the `plan*` keys instead, so Recharts draws the continuation as
 * its own dashed series. The handover day carries **both**, otherwise the
 * dashed line starts one day adrift of the solid one it continues.
 */
export interface ChartRow {
  date: string;
  label: string;
  load: number | null;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  planCtl: number | null;
  planAtl: number | null;
  planTsb: number | null;
  planLoad: number | null;
}

/**
 * The forward half of the chart: the solved taper when there is one, else the
 * rest projection. A taper is strictly more informative — it is the same
 * curves under a plan the athlete could follow — so it wins when both exist.
 */
export function planDays(data: FitnessTrendData): TrendDay[] {
  return data.taper && data.taper.days.length > 0
    ? data.taper.days
    : data.projection;
}

/** True when the forward half is a solved plan rather than rest. */
export function isPlanned(data: FitnessTrendData): boolean {
  return Boolean(data.taper && data.taper.days.length > 0);
}

export function buildChartRows(data: FitnessTrendData): ChartRow[] {
  const blank = {
    load: null,
    ctl: null,
    atl: null,
    tsb: null,
    planCtl: null,
    planAtl: null,
    planTsb: null,
    planLoad: null,
  };

  const rows: ChartRow[] = data.series.map((day) => ({
    ...blank,
    date: day.date,
    label: formatShortDate(day.date),
    load: day.load,
    ctl: day.ctl,
    atl: day.atl,
    tsb: day.tsb,
  }));

  const plan = planDays(data);
  const handover = rows[rows.length - 1];
  if (plan.length > 0 && handover) {
    handover.planCtl = handover.ctl;
    handover.planAtl = handover.atl;
    handover.planTsb = handover.tsb;
  }

  for (const day of plan) {
    rows.push({
      ...blank,
      date: day.date,
      label: formatShortDate(day.date),
      planCtl: day.ctl,
      planAtl: day.atl,
      planTsb: day.tsb,
      planLoad: day.load,
    });
  }

  return rows;
}

/**
 * Whether the window holds anything to chart. A zero-filled series is not
 * empty by row count but plots a flat line at zero, which is a worse answer
 * than saying so. Whole-body CTL/ATL is read from wellness directly, so a
 * rest day can carry zero load while still holding real (non-zero) fitness
 * and fatigue built up from earlier days; either signal is enough to chart.
 */
export function hasRecordedLoad(data: FitnessTrendData): boolean {
  return data.series.some(
    (day) => day.load > 0 || day.ctl !== 0 || day.atl !== 0,
  );
}

/** Axis label of the last recorded day — where the plan takes over. */
export function handoverLabel(data: FitnessTrendData): string | null {
  const last = data.series[data.series.length - 1];
  return last ? formatShortDate(last.date) : null;
}

/** Fill colors per band kind. Fatigue reads as a warning, freshness does not. */
export const BAND_COLORS: Record<TrendBand["kind"], string> = {
  "deep-fatigue": "var(--chart-heartrate)",
  fresh: "var(--color-text-success)",
  "steep-ramp": "var(--chart-cadence)",
};

/** Short human name per band kind, for legends and narration. */
export const BAND_LABELS: Record<TrendBand["kind"], string> = {
  "deep-fatigue": "Deep fatigue",
  fresh: "Fresh",
  "steep-ramp": "Steep ramp",
};

/**
 * Band kinds present in the window with their counts, in the server's order
 * (fatigue, freshness, ramp) — one legend toggle each, so overlapping shades
 * can be told apart.
 */
export function countBandKinds(
  bands: TrendBand[],
): { kind: TrendBand["kind"]; count: number }[] {
  const counts = new Map<TrendBand["kind"], number>();
  for (const band of bands) {
    counts.set(band.kind, (counts.get(band.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/** SummaryBar row: today's fitness, fatigue, form, and what comes next. */
export function buildSummaryStats(data: FitnessTrendData): SummaryStat[] {
  const current = data.current;
  const stats: SummaryStat[] = [
    { label: "Fitness", value: current ? `${current.ctl}` : "—" },
    { label: "Fatigue", value: current ? `${current.atl}` : "—" },
    { label: "Form", value: current ? signedTsb(current.tsb) : "—" },
  ];

  if (data.taper) {
    stats.push({
      label: `Form on ${formatShortDate(data.taper.targetDate)}`,
      value: signedTsb(data.taper.achievedTsb),
    });
  } else if (data.tsbPositiveDate) {
    stats.push({
      label: "Fresh on",
      value: formatShortDate(data.tsbPositiveDate),
    });
  } else {
    stats.push({ label: "Activities", value: `${data.activitiesIncluded}` });
  }

  return stats;
}

/**
 * "90 days · 2 May – 30 Jul", plus the taper target when one was solved —
 * the card is otherwise detached from the tool call that produced it.
 */
export function buildTrendSubtitle(data: FitnessTrendData): string {
  const first = data.series[0];
  const last = data.series[data.series.length - 1];
  if (!first || !last) return `Last ${data.days} days`;

  const span =
    first.date === last.date
      ? formatShortDate(first.date)
      : `${formatShortDate(first.date)} – ${formatShortDate(last.date)}`;
  const base = `${data.days} day${data.days === 1 ? "" : "s"} · ${span}`;
  return data.taper
    ? `${base} · taper to ${formatShortDate(data.taper.targetDate)}`
    : base;
}

/** "35/day, 28% of recent" — one week of the plan, for the plan list. */
export function formatTaperWeek(week: TaperPlan["weeks"][number]): string {
  const recent =
    week.pctOfRecent === null ? "" : `, ${week.pctOfRecent}% of recent`;
  return `${week.dailyLoad}/day${recent}`;
}
