/** One day of the performance-management chart. */
export interface TrendDay {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Training load recorded (or planned) that day; intervals.icu units, unitless. */
  load: number;
  /** Chronic training load — "fitness". */
  ctl: number;
  /** Acute training load — "fatigue". */
  atl: number;
  /** Training stress balance — "form", CTL − ATL. */
  tsb: number;
}

/** A dated stretch of the series the server thinks is worth annotating. */
export interface TrendBand {
  kind: "deep-fatigue" | "fresh" | "steep-ramp";
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
}

/** One week of the solved taper plan. */
export interface TaperWeek {
  week: number;
  startDate: string;
  endDate: string;
  days: number;
  dailyLoad: number;
  weekLoad: number;
  /** Percentage of the athlete's trailing 28-day average, when there is one. */
  pctOfRecent: number | null;
}

/** Load plan landing on a target form, solved server-side. */
export interface TaperPlan {
  targetDate: string;
  targetTsb: number;
  /** Form the plan lands on — equals targetTsb unless it had to be clamped. */
  achievedTsb: number;
  feasible: boolean;
  note: string | null;
  weeks: TaperWeek[];
  days: TrendDay[];
  totalLoad: number;
  recentDailyLoad: number;
}

/** Response from the get-fitness-trend-data tool. */
export interface FitnessTrendData {
  /** Lookback window in days. */
  days: number;
  /** Recorded days, oldest first. */
  series: TrendDay[];
  /** Zero-load decay past the last recorded day. */
  projection: TrendDay[];
  /** Solved taper, when the caller named a target date. */
  taper: TaperPlan | null;
  current: TrendDay | null;
  /** First projected date form returns positive, if it does. */
  tsbPositiveDate: string | null;
  bands: TrendBand[];
  /** The bands that run to today — what the text tool prints. */
  flags: string[];
  activitiesIncluded: number;
  activitiesMissingLoad: number;
}
