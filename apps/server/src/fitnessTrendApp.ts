/**
 * Payload mapping for the `view-fitness-trend` MCP App.
 *
 * The app renders the same CTL/ATL/TSB series, warning bands, and solved
 * taper the `get-fitness-trend` text tool prints — `fitnessTrend.ts` is the
 * only place either of them computes anything, so the chart and the prose
 * cannot drift. This module is the wire shape in between: camelCase, and
 * carrying only what the chart draws.
 */

import { type FitnessTrendDay, type FitnessTrendResult } from "./fitnessTrend";

export interface TrendBandData {
  kind: "deep-fatigue" | "fresh" | "steep-ramp";
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
}

export interface TaperWeekData {
  week: number;
  startDate: string;
  endDate: string;
  days: number;
  dailyLoad: number;
  weekLoad: number;
  pctOfRecent: number | null;
}

export interface TaperPlanData {
  targetDate: string;
  targetTsb: number;
  achievedTsb: number;
  feasible: boolean;
  note: string | null;
  weeks: TaperWeekData[];
  days: FitnessTrendDay[];
  totalLoad: number;
  recentDailyLoad: number;
}

export interface FitnessTrendAppData {
  days: number;
  series: FitnessTrendDay[];
  projection: FitnessTrendDay[];
  taper: TaperPlanData | null;
  current: FitnessTrendDay | null;
  tsbPositiveDate: string | null;
  bands: TrendBandData[];
  flags: string[];
  activitiesIncluded: number;
  activitiesMissingLoad: number;
  /**
   * Date `current`/the projection seed are known for (mirrors the text
   * tool's `as_of`); optional since older consumers of this payload never
   * carried it.
   */
  asOf?: string | null;
  /**
   * Where `current` CTL/ATL came from (mirrors the text tool's `source`).
   * Always `"intervals.icu"` here: this app is whole-body only. Optional
   * for the same reason as {@link FitnessTrendAppData.asOf}.
   */
  source?: "intervals.icu";
}

export interface FitnessTrendAppMeta {
  /** Lookback window the caller asked for. */
  days: number;
  activitiesIncluded: number;
  activitiesMissingLoad: number;
}

/** Map a computed trend to the app's wire shape. */
export function mapFitnessTrendApp(
  trend: FitnessTrendResult,
  meta: FitnessTrendAppMeta,
): FitnessTrendAppData {
  return {
    days: meta.days,
    series: trend.days,
    projection: trend.projection,
    taper: trend.taper
      ? {
          targetDate: trend.taper.target_date,
          targetTsb: trend.taper.target_tsb,
          achievedTsb: trend.taper.achieved_tsb,
          feasible: trend.taper.feasible,
          note: trend.taper.note,
          weeks: trend.taper.weeks.map((week) => ({
            week: week.week,
            startDate: week.start_date,
            endDate: week.end_date,
            days: week.days,
            dailyLoad: week.daily_load,
            weekLoad: week.week_load,
            pctOfRecent: week.pct_of_recent,
          })),
          days: trend.taper.days,
          totalLoad: trend.taper.total_load,
          recentDailyLoad: trend.taper.recent_daily_load,
        }
      : null,
    current: trend.current,
    tsbPositiveDate: trend.tsbPositiveDate,
    bands: trend.bands.map((band) => ({
      kind: band.kind,
      startDate: band.start_date,
      endDate: band.end_date,
      days: band.days,
      reason: band.reason,
    })),
    flags: trend.flags,
    activitiesIncluded: meta.activitiesIncluded,
    activitiesMissingLoad: meta.activitiesMissingLoad,
    asOf: trend.current?.date ?? null,
    source: "intervals.icu",
  };
}
