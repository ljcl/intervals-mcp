import { type WellnessTrendData, type WellnessTrendPoint } from "../types";

/** YYYY-MM-DD `n` days after 2026-10-01. */
const day = (n: number) =>
  new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);

/** Days with no record at all (the watch was off), and days with no sleep. */
const NO_RECORD = new Set([6, 7, 18]);
const NO_SLEEP = new Set([12, 25]);

/**
 * 30 days of a recovering athlete: HRV climbing, resting HR easing, with no
 * record on 7-8 Oct and 19 Oct and no sleep on 13 and 26 Oct, so the chart's
 * gaps are visible.
 */
const dailyPoints: WellnessTrendPoint[] = Array.from({ length: 30 }, (_, i) =>
  NO_RECORD.has(i)
    ? { date: day(i), hrv: null, restingHr: null, sleepHours: null }
    : {
        date: day(i),
        hrv: Math.round((48 + i * 0.4 + ((i * 7) % 5) - 2) * 10) / 10,
        restingHr: 54 - Math.floor(i / 8) + ((i * 3) % 3) - 1,
        sleepHours: NO_SLEEP.has(i)
          ? null
          : Math.round((7.2 + (((i * 5) % 7) - 3) * 0.25) * 10) / 10,
      },
);

export const dailyData: WellnessTrendData = {
  oldest: "2026-10-01",
  newest: "2026-10-30",
  granularity: "daily",
  count: 27,
  hrvMeasure: "rmssd",
  hrvNote: "HRV is rMSSD (hrv_rmssd_ms). SDNN (hrv_sdnn_ms) is null.",
  points: dailyPoints,
};

/** A device that records SDNN and no sleep: two panels. */
export const sdnnNoSleepData: WellnessTrendData = {
  ...dailyData,
  hrvMeasure: "sdnn",
  hrvNote:
    "HRV is SDNN (hrv_sdnn_ms), not rMSSD (hrv_rmssd_ms is null). Do not compare SDNN values with rMSSD norms.",
  points: dailyPoints.map((p) => ({ ...p, sleepHours: null })),
};

/** 26 Monday-start weeks, past the 90-day weekly threshold, one week empty. */
export const weeklyData: WellnessTrendData = {
  oldest: "2026-05-11",
  newest: "2026-11-08",
  granularity: "weekly",
  count: 170,
  hrvMeasure: "rmssd",
  hrvNote: "HRV is rMSSD (hrv_rmssd_ms). SDNN (hrv_sdnn_ms) is null.",
  points: Array.from({ length: 26 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 4, 11 + i * 7))
      .toISOString()
      .slice(0, 10);
    return i === 12
      ? { date, hrv: null, restingHr: null, sleepHours: null, days: 0 }
      : {
          date,
          hrv: Math.round((52 + Math.sin(i / 3) * 6) * 10) / 10,
          restingHr: Math.round((51 + Math.cos(i / 4) * 2) * 10) / 10,
          sleepHours: Math.round((7.1 + Math.sin(i / 2) * 0.4) * 10) / 10,
          days: i === 25 ? 6 : 7,
        };
  }),
};

/** Wellness records exist, but none carries HRV, resting HR or sleep. */
export const emptyData: WellnessTrendData = {
  ...dailyData,
  count: 3,
  hrvMeasure: null,
  hrvNote: "No HRV recorded.",
  points: dailyPoints.map((p) => ({
    ...p,
    hrv: null,
    restingHr: null,
    sleepHours: null,
  })),
};
