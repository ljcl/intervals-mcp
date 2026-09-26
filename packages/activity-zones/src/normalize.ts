import {
  dominantBucket,
  formatDurationShort,
  formatShortDate,
} from "@intervals-mcp/data";
import { type SummaryStat } from "@intervals-mcp/ui";
import { type ActivityZonesData, type ZoneBucket, type ZoneSet } from "./types";

/** One chart row per zone bucket. */
export interface ZoneRow {
  label: string;
  /** "0–120 bpm" or "175+ bpm". */
  range: string;
  minutes: number;
  seconds: number;
  pct: number;
}

export function formatZoneRange(bucket: ZoneBucket, unit: string): string {
  return bucket.max == null
    ? `${bucket.min}+ ${unit}`
    : `${bucket.min}–${bucket.max} ${unit}`;
}

export function buildZoneRows(set: ZoneSet): ZoneRow[] {
  return set.buckets.map((bucket) => ({
    label: `Z${bucket.zone}`,
    range: formatZoneRange(bucket, set.unit),
    minutes: Math.round((bucket.seconds / 60) * 10) / 10,
    seconds: bucket.seconds,
    pct: bucket.pct,
  }));
}

/**
 * Easy/moderate/hard split percentages: zones 1–2 are easy, zone 3 moderate,
 * zone 4 and above hard. Matches the intensity distribution convention used
 * by the running-summary tool for 5-zone HR and degrades sensibly for the
 * 6+-zone power sets.
 */
export function intensitySplit(set: ZoneSet): {
  easyPct: number;
  moderatePct: number;
  hardPct: number;
} {
  let easy = 0;
  let moderate = 0;
  let hard = 0;
  for (const bucket of set.buckets) {
    if (bucket.zone <= 2) easy += bucket.seconds;
    else if (bucket.zone === 3) moderate += bucket.seconds;
    else hard += bucket.seconds;
  }
  const total = set.totalSeconds || 1;
  const pct = (v: number) => Math.round((v / total) * 1000) / 10;
  return { easyPct: pct(easy), moderatePct: pct(moderate), hardPct: pct(hard) };
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
  const split = intensitySplit(set);
  return [
    { label: "Time", value: formatDurationShort(set.totalSeconds) },
    { label: "Mostly", value: `Z${dominantBucket(set).zone}` },
    { label: "Easy Z1–2", value: `${split.easyPct}%` },
    { label: "Hard Z4+", value: `${split.hardPct}%` },
  ];
}
