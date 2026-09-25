/** One week of training volume, returned by get-training-load-data. */
export interface WeekSummary {
  /** Monday-start week key, YYYY-MM-DD. */
  weekStarting: string;
  runs: number;
  distanceKm: number;
  timeHours: number;
  elevationM: number;
  /** Rolling-average volume for the trend line, in km. */
  trendKm: number;
  warning: boolean;
  warningReasons: string[];
  /** Sum of icu_training_load over the included types this week. */
  load?: number;
  /** `load` split by activity type. */
  loadByType?: Record<string, number>;
}

/** Most recent CTL/ATL/TSB, from get-training-load-data. */
export interface TrainingLoadCurrent {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
}

/** Response from the get-training-load-data tool. */
export interface TrainingLoadData {
  days: number;
  totals: {
    runs: number;
    distanceKm: number;
    timeHours: number;
    elevationM: number;
    load?: number;
  };
  weeks: WeekSummary[];
  /** Activity types load/loadByType are summed over. */
  activityTypesIncluded?: string[];
  /** True when load is run-only rather than whole-body. */
  runOnly?: boolean;
  current?: TrainingLoadCurrent | null;
  source?: "intervals.icu" | "computed" | null;
}
