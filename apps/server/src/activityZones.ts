/**
 * Pure mapping for the activity-zones MCP App feed. Turns the raw
 * `/activities/{id}/zones` response into the chart-ready payload that
 * `get-activity-zones-data` returns, unit-tested in `activityZones.test.ts`.
 * The `get-activity-zones` text tool formats the same
 * fetch as prose; this feed carries per-bucket seconds and percentages so
 * the chart and the text can never disagree on the numbers.
 */
import { type ZoneSet } from "@intervals-mcp/data";
import { type StravaActivityZone } from "./stravaClient";

export interface ActivityZonesData {
  activityId: string;
  name: string;
  /** Local start date, ISO. */
  date: string;
  type: string;
  zoneSets: ZoneSet[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Map the raw zone response to chart-ready sets. Sets without distribution
 * buckets (no sensor) and unknown set types are dropped; a zero-time set is
 * kept only if some bucket has time.
 */
export function mapActivityZones(zones: StravaActivityZone[]): ZoneSet[] {
  const sets: ZoneSet[] = [];
  for (const zone of zones) {
    if (zone.type !== "heartrate" && zone.type !== "power") continue;
    const buckets = zone.distribution_buckets ?? [];
    const totalSeconds = buckets.reduce((sum, b) => sum + b.time, 0);
    if (buckets.length === 0 || totalSeconds <= 0) continue;

    sets.push({
      type: zone.type,
      unit: zone.type === "heartrate" ? "bpm" : "W",
      sensorBased: zone.sensor_based ?? null,
      totalSeconds,
      buckets: buckets.map((bucket, i) => ({
        zone: i + 1,
        min: bucket.min,
        max: bucket.max === -1 ? null : bucket.max,
        seconds: bucket.time,
        pct: round1((bucket.time / totalSeconds) * 100),
      })),
    });
  }
  return sets;
}
