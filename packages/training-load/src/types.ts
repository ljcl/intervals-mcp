/** One week of training volume, returned by get-training-load-data. */
export interface WeekSummary {
  /** Monday-start week key, YYYY-MM-DD. */
  weekStarting: string;
  runs: number;
  distanceKm: number;
  timeHours: number;
  elevationM: number;
  /**
   * Rolling-average volume for the trend line, in km, over complete weeks.
   * Null for the week in progress, so the line ends at the last complete week.
   */
  trendKm: number | null;
  /** The current week: its volume is only the days so far. */
  inProgress?: boolean;
  warning: boolean;
  warningReasons: string[];
  /** Sum of icu_training_load over the included types this week. */
  load: number;
  /** `load` split by activity type. */
  loadByType: Record<string, number>;
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
  /** Calendar days read: whole weeks plus the current week so far. */
  days: number;
  /** First day read (a Monday) and the last (today), YYYY-MM-DD. */
  startDate?: string;
  endDate?: string;
  totals: {
    runs: number;
    distanceKm: number;
    timeHours: number;
    elevationM: number;
    load: number;
  };
  weeks: WeekSummary[];
  /** Activity types load/loadByType are summed over. */
  activityTypesIncluded: string[];
  /**
   * True when load and CTL/ATL/TSB are run-only rather than whole-body. Volume
   * and spike warnings are run-based either way.
   */
  runOnly: boolean;
  /** Most recent CTL/ATL/TSB; null when there is no wellness to read. */
  current: TrainingLoadCurrent | null;
  /** Where `current` came from: intervals.icu wellness, or computed locally. */
  source: "intervals.icu" | "computed" | null;
}
