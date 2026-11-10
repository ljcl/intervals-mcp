import { formatShortDate } from "@intervals-mcp/data";
import { type WellnessTrendData, type WellnessTrendPoint } from "./types";

export type SeriesKey = "hrv" | "restingHr" | "sleepHours";

export interface SeriesSpec {
  key: SeriesKey;
  label: string;
  unit: string;
  color: string;
}

/** The three panels, top to bottom. HRV names the one measure it plots. */
export function seriesSpecs(data: WellnessTrendData): SeriesSpec[] {
  return [
    {
      key: "hrv",
      label: data.hrvMeasure === "sdnn" ? "HRV (SDNN)" : "HRV (rMSSD)",
      unit: "ms",
      color: "var(--chart-power)",
    },
    {
      key: "restingHr",
      label: "Resting HR",
      unit: "bpm",
      color: "var(--chart-heartrate)",
    },
    {
      key: "sleepHours",
      label: "Sleep",
      unit: "h",
      color: "var(--chart-pace)",
    },
  ];
}

/** The series with at least one value: a panel with none is left out. */
export function chartedSeries(data: WellnessTrendData): SeriesSpec[] {
  return seriesSpecs(data).filter((spec) =>
    data.points.some((p) => p[spec.key] != null),
  );
}

export interface SeriesStats {
  /** Points with a value. */
  count: number;
  min: number;
  max: number;
  first: WellnessTrendPoint;
  last: WellnessTrendPoint;
}

export function seriesStats(
  data: WellnessTrendData,
  key: SeriesKey,
): SeriesStats | null {
  const withValue = data.points.filter((p) => p[key] != null);
  const first = withValue[0];
  const last = withValue.at(-1);
  if (!first || !last) return null;
  const values = withValue.map((p) => p[key] as number);
  return {
    count: withValue.length,
    min: Math.min(...values),
    max: Math.max(...values),
    first,
    last,
  };
}

export const isWeekly = (data: WellnessTrendData) =>
  data.granularity === "weekly";

/** "1 Oct to 30 Oct 2026", the year on the first date only when it differs. */
export function rangeLabel(data: WellnessTrendData): string {
  const sameYear = data.oldest.slice(0, 4) === data.newest.slice(0, 4);
  return `${formatShortDate(data.oldest, sameYear ? "none" : "full")} to ${formatShortDate(data.newest, "full")}`;
}

export function buildSubtitle(data: WellnessTrendData): string {
  return isWeekly(data)
    ? `${rangeLabel(data)} · weekly averages`
    : rangeLabel(data);
}

/** A point's date as the tooltip and narration name it. */
export function pointLabel(
  data: WellnessTrendData,
  point: WellnessTrendPoint,
): string {
  const date = formatShortDate(point.date, "full");
  if (!isWeekly(data)) return date;
  const days = point.days ?? 0;
  return `Week of ${date} (${days} day${days === 1 ? "" : "s"})`;
}

/** "55 ms", "7.4 h". */
export function formatValue(spec: SeriesSpec, value: number): string {
  return `${value} ${spec.unit}`;
}
