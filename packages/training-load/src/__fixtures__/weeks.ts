import { type TrainingLoadData, type WeekSummary } from "../types";

/** A week's run volume, before any load is attached to it. */
type VolumeWeek = Omit<WeekSummary, "load" | "loadByType">;

/**
 * 12 weeks of build with one skipped week and one volume-spike week (over
 * 1.5 times the average of the 4 weeks before it, as the server flags it),
 * then the current week in progress: exercises the trend line, the
 * zero-fill row, the warning, and the partial bar.
 */
const volumeWeeks: VolumeWeek[] = [
  {
    weekStarting: "2026-03-30",
    runs: 3,
    distanceKm: 24.5,
    timeHours: 2.45,
    elevationM: 180,
    trendKm: 26.2,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-04-06",
    runs: 4,
    distanceKm: 27.8,
    timeHours: 2.8,
    elevationM: 210,
    trendKm: 27.5,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-04-13",
    runs: 4,
    distanceKm: 30.1,
    timeHours: 3.05,
    elevationM: 240,
    trendKm: 29.5,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-04-20",
    runs: 4,
    distanceKm: 30.5,
    timeHours: 3.1,
    elevationM: 220,
    trendKm: 20.2,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-04-27",
    runs: 0,
    distanceKm: 0,
    timeHours: 0,
    elevationM: 0,
    trendKm: 20.6,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-05-04",
    runs: 4,
    distanceKm: 31.2,
    timeHours: 3.1,
    elevationM: 260,
    trendKm: 21.5,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-05-11",
    runs: 5,
    distanceKm: 33.4,
    timeHours: 3.35,
    elevationM: 300,
    trendKm: 32.9,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-05-18",
    runs: 5,
    distanceKm: 34,
    timeHours: 3.4,
    elevationM: 280,
    trendKm: 40.3,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-05-25",
    runs: 6,
    distanceKm: 53.5,
    timeHours: 5.4,
    elevationM: 420,
    trendKm: 42.6,
    warning: true,
    warningReasons: [
      "Volume spike: 53.5 km is 2.17 times the 24.6 km average of the previous 4 weeks",
    ],
  },
  {
    weekStarting: "2026-06-01",
    runs: 4,
    distanceKm: 40.3,
    timeHours: 4.05,
    elevationM: 310,
    trendKm: 41.2,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-06-08",
    runs: 4,
    distanceKm: 29.8,
    timeHours: 3,
    elevationM: 230,
    trendKm: 34.3,
    warning: false,
    warningReasons: [],
  },
  {
    weekStarting: "2026-06-15",
    runs: 4,
    distanceKm: 32.9,
    timeHours: 3.3,
    elevationM: 250,
    trendKm: 31.4,
    warning: false,
    warningReasons: [],
  },
  {
    // The current week, Monday to Wednesday so far: a partial bar with no
    // trend point, as the server sends it.
    weekStarting: "2026-06-22",
    runs: 2,
    distanceKm: 14.6,
    timeHours: 1.45,
    elevationM: 110,
    trendKm: null,
    inProgress: true,
    warning: false,
    warningReasons: [],
  },
];

/**
 * Run load per week, aligned with `volumeWeeks`. Load tracks effort rather
 * than distance, so it is not a multiple of the km.
 */
const RUN_LOAD = [
  210, 240, 265, 270, 0, 280, 300, 305, 480, 360, 270, 295, 130,
];

/**
 * Cross-training load per week (rides). The skipped run week still carries
 * 150 of it, which is what the whole-body line shows and a run-only one
 * cannot.
 */
const RIDE_LOAD = [60, 0, 80, 0, 150, 70, 0, 90, 0, 100, 0, 75, 40];

/** `loadByType` for the given type loads; a type with no load is absent, as the server omits it. */
const byType = (loads: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(loads).filter(([, load]) => load > 0));

/** Whole-body weeks: runs plus rides, load split by type. */
export const mockWeeks: WeekSummary[] = volumeWeeks.map((week, i) => ({
  ...week,
  load: RUN_LOAD[i]! + RIDE_LOAD[i]!,
  loadByType: byType({ Run: RUN_LOAD[i]!, Ride: RIDE_LOAD[i]! }),
}));

/** The same weeks counting runs only: the rides drop out of load. */
export const mockRunOnlyWeeks: WeekSummary[] = volumeWeeks.map((week, i) => ({
  ...week,
  load: RUN_LOAD[i]!,
  loadByType: byType({ Run: RUN_LOAD[i]! }),
}));

const layoffWeek = (
  weekStarting: string,
  distanceKm: number,
  trendKm: number | null,
): WeekSummary => ({
  weekStarting,
  runs: distanceKm > 0 ? 5 : 0,
  distanceKm,
  timeHours: distanceKm / 10,
  elevationM: distanceKm * 8,
  trendKm,
  inProgress: trendKm === null,
  warning: false,
  warningReasons: [],
  load: distanceKm * 5,
  loadByType: distanceKm > 0 ? { Run: distanceKm * 5 } : {},
});

/**
 * Two 50 km weeks, then a layoff that is still going on: two empty complete
 * weeks and the current week with no run yet. The server runs the timeline
 * on to the current week, so the bars and the trend line show the layoff.
 */
export const layoffWeeks: WeekSummary[] = [
  layoffWeek("2026-06-01", 50, 50),
  layoffWeek("2026-06-08", 50, 33.33),
  layoffWeek("2026-06-15", 0, 16.67),
  layoffWeek("2026-06-22", 0, 0),
  layoffWeek("2026-06-29", 0, null),
];

/** The server's payload shape around a set of weeks. */
const payloadFor = (
  weeks: WeekSummary[],
  scope: Pick<
    TrainingLoadData,
    "runOnly" | "activityTypesIncluded" | "current" | "source"
  >,
): TrainingLoadData => ({
  // 12 complete weeks plus Monday to Wednesday of the current one.
  days: 87,
  startDate: "2026-03-30",
  endDate: "2026-06-24",
  totals: {
    runs: weeks.reduce((sum, w) => sum + w.runs, 0),
    distanceKm:
      Math.round(weeks.reduce((sum, w) => sum + w.distanceKm, 0) * 100) / 100,
    timeHours:
      Math.round(weeks.reduce((sum, w) => sum + w.timeHours, 0) * 100) / 100,
    elevationM: weeks.reduce((sum, w) => sum + w.elevationM, 0),
    load: weeks.reduce((sum, w) => sum + w.load, 0),
  },
  weeks,
  ...scope,
});

/** Full data payload matching the mock weeks, for App-level stories: whole-body load, CTL/ATL read from intervals.icu. */
export const mockTrainingLoadData: TrainingLoadData = payloadFor(mockWeeks, {
  runOnly: false,
  activityTypesIncluded: ["Ride", "Run"],
  current: { date: "2026-06-24", ctl: 52, atl: 61, tsb: -9 },
  source: "intervals.icu",
});

/** The run-only scope: load over runs, CTL/ATL computed locally. */
export const mockRunOnlyTrainingLoadData: TrainingLoadData = payloadFor(
  mockRunOnlyWeeks,
  {
    runOnly: true,
    activityTypesIncluded: ["Run", "TrailRun", "VirtualRun"],
    current: { date: "2026-06-24", ctl: 41, atl: 47.5, tsb: -6.5 },
    source: "computed",
  },
);
