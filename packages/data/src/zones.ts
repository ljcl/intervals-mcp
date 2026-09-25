/**
 * Zone-distribution wire types shared by the server's activity-zones feed
 * and the activity-zones MCP App, plus the one derivation both surfaces
 * print. Living here keeps the `get-activity-zones` text tool and the chart
 * agreeing on the same dominant zone for the same activity.
 */

/** One zone bucket, as returned by get-activity-zones-data. */
export interface ZoneBucket {
  /** 1-based zone number (Z1 = 1). */
  zone: number;
  /** Lower bound in the set's unit (bpm or W). */
  min: number;
  /** Upper bound; intervals.icu always sends a real number, even for the
   * top zone, so this is never null in practice today. */
  max: number | null;
  seconds: number;
  /** Share of the set's total time, 0–100 with one decimal. */
  pct: number;
}

/** One zone distribution (heart rate or power). */
export interface ZoneSet {
  type: "heartrate" | "power";
  unit: "bpm" | "W";
  /** Whether the zones came from a real sensor (null when Strava omits it). */
  sensorBased: boolean | null;
  totalSeconds: number;
  buckets: ZoneBucket[];
}

/** The bucket with the most time in a set (first wins ties). */
export function dominantBucket(set: ZoneSet): ZoneBucket {
  return set.buckets.reduce((top, bucket) =>
    bucket.seconds > top.seconds ? bucket : top,
  );
}
