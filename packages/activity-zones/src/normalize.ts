import {
  dominantBucket,
  formatDurationShort,
  formatShortDate,
  hrZoneRangeText,
  intensitySplit,
} from "@intervals-mcp/data";
import { type SummaryStat } from "@intervals-mcp/ui";
import { type ActivityZonesData, type ZoneBucket, type ZoneSet } from "./types";

/** One chart row per zone bucket. */
export interface ZoneRow {
  label: string;
  /** "up to 120 bpm", "176-197 bpm", or "400+ W". */
  range: string;
  minutes: number;
  seconds: number;
  pct: number;
}

export function formatZoneRange(
  bucket: ZoneBucket,
  { type, unit }: Pick<ZoneSet, "type" | "unit">,
): string {
  if (bucket.max == null) return `${bucket.min}+ ${unit}`;
  return type === "heartrate"
    ? hrZoneRangeText({ min: bucket.min, max: bucket.max }, ` ${unit}`)
    : `${bucket.min}–${bucket.max} ${unit}`;
}

export function buildZoneRows(set: ZoneSet): ZoneRow[] {
  return set.buckets.map((bucket) => ({
    label: `Z${bucket.zone}`,
    range: formatZoneRange(bucket, set),
    minutes: Math.round((bucket.seconds / 60) * 10) / 10,
    seconds: bucket.seconds,
    pct: bucket.pct,
  }));
}

/**
 * "Run · 12 Jul · Heart rate zones" — the header subtitle. Names the set on
 * screen because the pill row only appears when both sets exist, so a
 * heart-rate-only card would otherwise never say what it is charting.
 */
export function buildZonesSubtitle(
  data: Pick<ActivityZonesData, "type" | "date">,
  set: ZoneSet,
): string {
  const setLabel = set.type === "power" ? "Power zones" : "Heart rate zones";
  return [data.type, formatShortDate(data.date), setLabel]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The no-data line. When the server dropped heart rate zones for a known
 * reason, `hrZoneWarning` gives it in the words the text tools print.
 * Otherwise the app knows no reason, so the line gives none. A "no sensor"
 * claim would often be false: power zones are always dropped for now.
 */
export function buildEmptyMessage(
  data: Pick<ActivityZonesData, "hrZoneWarning">,
): string {
  const message = "No zone data to show for this activity.";
  return data.hrZoneWarning ? `${message} ${data.hrZoneWarning}` : message;
}

/** SummaryBar stats for the active zone set. */
export function buildSummaryStats(set: ZoneSet): SummaryStat[] {
  const split = intensitySplit(set.buckets.map((b) => b.seconds));
  return [
    { label: "Time", value: formatDurationShort(set.totalSeconds) },
    { label: "Mostly", value: `Z${dominantBucket(set).zone}` },
    { label: "Easy Z1–2", value: `${split.easyPct}%` },
    { label: "Hard Z4+", value: `${split.hardPct}%` },
  ];
}
