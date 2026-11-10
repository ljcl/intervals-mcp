/**
 * Wellness-trend wire types, shared by the server's `get-wellness-trend-data`
 * feed and the wellness-trend MCP App, so the two cannot read different
 * shapes. The numbers are get-wellness's own (`loadWellness`), renamed.
 */

/** One calendar day, or one Monday-start week, of the chart. */
export interface WellnessTrendPoint {
  /** ISO date, YYYY-MM-DD: the day, or the Monday of the week. */
  date: string;
  /** HRV in ms, in the payload's `hrvMeasure`; null on a day with none. */
  hrv: number | null;
  restingHr: number | null;
  /** Hours, 1 dp. */
  sleepHours: number | null;
  /** Weekly points only: days in the week with a wellness record. */
  days?: number;
}

/** Response from the get-wellness-trend-data tool. */
export interface WellnessTrendData {
  oldest: string;
  newest: string;
  /** Weekly past 90 days, as get-wellness. */
  granularity: "daily" | "weekly";
  /** Days with a wellness record. */
  count: number;
  /** The HRV measure `hrv` holds; null when no day has HRV. */
  hrvMeasure: "rmssd" | "sdnn" | null;
  /** get-wellness's hrv_note. */
  hrvNote: string;
  /**
   * Oldest first, one per calendar day (or week) in the range, so a day with
   * no record is a null point, drawn as a gap.
   */
  points: WellnessTrendPoint[];
}
