/**
 * Rounds `value` to `dp` decimal places (default 0). The one home for the
 * round-to-N-decimals helper the intervals.icu read tools each hand-rolled
 * an identical copy of (get-activity, get-activity-streams, list-gear,
 * get-wellness).
 */
export function round(value: number, dp = 0): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Note appended when an activity's `source` is `"STRAVA"`: intervals.icu has
 * no further detail for it through this API (see docs/api-notes.md's Strava
 * stub spike). Shared by list-activities and get-activity so the wording
 * matches in both places.
 */
export const STRAVA_STUB_NOTE =
  "stub: details unavailable through the API; use the HealthFit copy.";

/**
 * Format duration in seconds to HH:MM:SS or MM:SS string.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    Number.isNaN(seconds) ||
    seconds < 0
  ) {
    return "N/A";
  }

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
