import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import { type IntervalsActivity, listActivities } from "../intervalsClient";
import { PACE_ACTIVITY_TYPES } from "../utils/running";
import {
  aggregateRunTotals,
  aggregateSportTotals,
  formatAthleteStatsText,
  getAthleteStatsTool,
  sameDateLastYear,
  startOfMonth,
  startOfYear,
} from "./getAthleteStats";
import { listActivitiesTool } from "./listActivities";
import { AthleteStatsOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, listActivities: vi.fn() };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedListActivities = vi.mocked(listActivities);
const fixture = activitiesFixture as unknown as IntervalsActivity[];

function run(
  overrides: Partial<IntervalsActivity> & { start_date_local: string },
): IntervalsActivity {
  return {
    id: "i1",
    type: "Run",
    distance: 5000,
    moving_time: 1500,
    total_elevation_gain: 50,
    icu_training_load: 40,
    ...overrides,
  } as IntervalsActivity;
}

describe("startOfMonth / startOfYear", () => {
  it("returns the first of the local calendar month", () => {
    expect(startOfMonth("2026-09-24")).toBe("2026-09-01");
  });

  it("returns 1 January of the local calendar year", () => {
    expect(startOfYear("2026-09-24")).toBe("2026-01-01");
  });
});

describe("sameDateLastYear", () => {
  it("keeps the month and day one year earlier", () => {
    expect(sameDateLastYear("2026-09-24")).toBe("2025-09-24");
  });

  it("maps 29 February to 28 February", () => {
    expect(sameDateLastYear("2028-02-29")).toBe("2027-02-28");
  });

  it("keeps 1 March after a leap day", () => {
    expect(sameDateLastYear("2025-03-01")).toBe("2024-03-01");
  });
});

describe("aggregateRunTotals", () => {
  it("sums only pace activity types within an inclusive date range", () => {
    const activities = [
      run({ id: "a", start_date_local: "2026-09-21T07:00:00" }),
      run({
        id: "b",
        type: "TrailRun",
        start_date_local: "2026-09-22T07:00:00",
        distance: 3000,
        moving_time: 900,
        total_elevation_gain: 20,
        icu_training_load: 25,
      }),
      run({
        id: "c",
        type: "WeightTraining",
        start_date_local: "2026-09-22T07:00:00",
        distance: 0,
      }),
      run({ id: "d", start_date_local: "2026-09-25T07:00:00" }),
    ];

    const totals = aggregateRunTotals(activities, "2026-09-21", "2026-09-24");

    expect(totals.runs).toBe(2);
    expect(totals.distance_km).toBe(8);
    expect(totals.moving_time_s).toBe(2400);
    expect(totals.elevation_gain_m).toBe(70);
    expect(totals.load).toBe(65);
    expect(totals.average_pace_min_per_km).not.toBeNull();
  });

  it("includes activities exactly on the start and end dates", () => {
    const activities = [
      run({ id: "start", start_date_local: "2026-01-01T06:00:00" }),
      run({ id: "end", start_date_local: "2026-12-31T06:00:00" }),
      run({ id: "before", start_date_local: "2025-12-31T06:00:00" }),
      run({ id: "after", start_date_local: "2027-01-01T06:00:00" }),
    ];

    const totals = aggregateRunTotals(activities, "2026-01-01", "2026-12-31");

    expect(totals.runs).toBe(2);
  });

  it("excludes Strava stub activities (source: STRAVA), which carry no real distance/time data", () => {
    const activities = [
      run({ id: "real", start_date_local: "2026-06-01T06:00:00" }),
      run({
        id: "stub",
        source: "STRAVA",
        start_date_local: "2026-06-02T06:00:00",
        distance: 10000,
        moving_time: 3000,
      }),
    ];

    const totals = aggregateRunTotals(activities, "2026-06-01", "2026-06-30");

    expect(totals.runs).toBe(1);
    expect(totals.distance_km).toBe(5);
  });

  it("returns a null average pace and zeroed totals for an empty bucket", () => {
    const totals = aggregateRunTotals([], "2026-09-21", "2026-09-24");

    expect(totals).toEqual({
      runs: 0,
      distance_km: 0,
      moving_time_s: 0,
      moving_time: "0:00",
      elevation_gain_m: 0,
      load: 0,
      average_pace_min_per_km: null,
      calories: 0,
      calories_missing: 0,
      longest_run: null,
    });
  });

  it("names the run with the most distance as the longest run", () => {
    const activities = [
      run({ id: "a", start_date_local: "2026-09-21T07:00:00" }),
      run({
        id: "b",
        start_date_local: "2026-09-22T07:00:00",
        distance: 21_097,
      }),
      run({
        id: "c",
        type: "Ride",
        start_date_local: "2026-09-23T07:00:00",
        distance: 60_000,
      }),
    ];

    expect(
      aggregateRunTotals(activities, "2026-09-21", "2026-09-24").longest_run,
    ).toEqual({ id: "b", date: "2026-09-22", distance_km: 21.1 });
  });

  it("skips a null training load rather than treating it as zero-valued noise", () => {
    const activities = [
      run({
        id: "a",
        start_date_local: "2026-09-21T07:00:00",
        icu_training_load: null,
      }),
      run({ id: "b", start_date_local: "2026-09-22T07:00:00" }),
    ];

    const totals = aggregateRunTotals(activities, "2026-09-21", "2026-09-24");

    expect(totals.load).toBe(40);
  });
});

describe("aggregateSportTotals", () => {
  it("groups every activity in an inclusive date range by its intervals.icu type", () => {
    const activities = [
      run({ id: "a", start_date_local: "2026-09-21T07:00:00" }),
      run({
        id: "b",
        type: "TrailRun",
        start_date_local: "2026-09-22T07:00:00",
      }),
      run({
        id: "c",
        type: "WeightTraining",
        start_date_local: "2026-09-22T18:00:00",
        distance: null,
      }),
      run({ id: "d", start_date_local: "2026-09-25T07:00:00" }),
      run({ id: "e", type: "Swim", start_date_local: "2026-09-20T07:00:00" }),
    ];

    const totals = aggregateSportTotals(activities, "2026-09-21", "2026-09-24");

    expect(Object.keys(totals.by_type).sort()).toEqual([
      "Run",
      "TrailRun",
      "WeightTraining",
    ]);
    expect(totals.by_type.Run?.count).toBe(1);
    expect(totals.by_type.TrailRun?.count).toBe(1);
    expect(totals.total.count).toBe(3);
  });

  it("reports a null distance for a type with no distance above 0", () => {
    const activities = [
      run({
        id: "a",
        type: "WeightTraining",
        start_date_local: "2026-09-21T07:00:00",
        distance: null,
      }),
      run({
        id: "b",
        type: "WeightTraining",
        start_date_local: "2026-09-22T07:00:00",
        distance: 0,
      }),
      run({
        id: "c",
        type: "Walk",
        start_date_local: "2026-09-21T07:00:00",
        distance: null,
      }),
      run({
        id: "d",
        type: "Walk",
        start_date_local: "2026-09-22T07:00:00",
        distance: 2000,
      }),
    ];

    const totals = aggregateSportTotals(activities, "2026-09-21", "2026-09-24");

    expect(totals.by_type.WeightTraining?.distance_km).toBeNull();
    expect(totals.by_type.Walk?.distance_km).toBe(2);
  });

  it("counts an activity with no load or moving time, adding 0", () => {
    const activities = [
      run({
        id: "a",
        type: "Yoga",
        start_date_local: "2026-09-21T07:00:00",
        distance: null,
        moving_time: null,
        icu_training_load: null,
      }),
      run({
        id: "b",
        type: "Yoga",
        start_date_local: "2026-09-22T07:00:00",
        distance: null,
        moving_time: 600,
        icu_training_load: 10,
      }),
    ];

    const totals = aggregateSportTotals(activities, "2026-09-21", "2026-09-24");

    expect(totals.by_type.Yoga).toEqual({
      count: 2,
      moving_time_s: 600,
      distance_km: null,
      load: 10,
      calories: null,
    });
  });

  it("keys an activity with no type as Unknown", () => {
    const totals = aggregateSportTotals(
      [run({ type: null, start_date_local: "2026-09-21T07:00:00" })],
      "2026-09-21",
      "2026-09-24",
    );

    expect(totals.by_type.Unknown?.count).toBe(1);
  });

  it("leaves out Strava stubs (source: STRAVA), as the run totals do", () => {
    const activities = [
      run({ id: "real", start_date_local: "2026-09-21T07:00:00" }),
      run({
        id: "stub",
        type: "Ride",
        source: "STRAVA",
        start_date_local: "2026-09-22T07:00:00",
      }),
    ];

    const totals = aggregateSportTotals(activities, "2026-09-21", "2026-09-24");

    expect(totals.by_type.Ride).toBeUndefined();
    expect(totals.total.count).toBe(1);
  });

  it("orders types by load, then moving time, then name", () => {
    const at = "2026-09-22T07:00:00";
    const activities = [
      run({
        id: "a",
        type: "Yoga",
        start_date_local: at,
        icu_training_load: 10,
        moving_time: 600,
      }),
      run({
        id: "b",
        type: "Swim",
        start_date_local: at,
        icu_training_load: 30,
        moving_time: 900,
      }),
      run({
        id: "c",
        type: "Ride",
        start_date_local: at,
        icu_training_load: 10,
        moving_time: 1200,
      }),
      run({
        id: "d",
        type: "Hike",
        start_date_local: at,
        icu_training_load: 10,
        moving_time: 1200,
      }),
    ];

    const totals = aggregateSportTotals(activities, "2026-09-21", "2026-09-24");

    expect(Object.keys(totals.by_type)).toEqual([
      "Swim",
      "Hike",
      "Ride",
      "Yoga",
    ]);
  });

  it("makes each total field the sum of by_type", () => {
    const totals = aggregateSportTotals(fixture, "2026-01-01", "2026-09-24");
    const rows = Object.values(totals.by_type);

    expect(rows.length).toBeGreaterThan(1);
    for (const key of ["count", "moving_time_s", "load", "calories"] as const) {
      const sum = rows.reduce((acc, row) => acc + (row[key] ?? 0), 0);
      expect(sum, key).toBe(totals.total[key]);
    }
  });

  it("returns zeroed totals and no types for an empty period", () => {
    expect(aggregateSportTotals([], "2026-09-21", "2026-09-24")).toEqual({
      total: {
        count: 0,
        moving_time_s: 0,
        load: 0,
        calories: 0,
        calories_missing: 0,
      },
      by_type: {},
    });
  });

  it("has run rows that add up to the run totals in every period", () => {
    const activities = [
      ...fixture,
      run({
        id: "trail",
        type: "TrailRun",
        start_date_local: "2026-09-23T07:00:00",
        moving_time: 1800,
        icu_training_load: 35,
      }),
      run({
        id: "stub",
        source: "STRAVA",
        start_date_local: "2026-09-23T18:00:00",
      }),
    ];
    const periods: Array<[string, string]> = [
      ["2026-09-21", "2026-09-24"],
      ["2026-08-28", "2026-09-24"],
      ["2026-09-01", "2026-09-24"],
      ["2026-01-01", "2026-09-24"],
    ];

    for (const [start, end] of periods) {
      const runTotals = aggregateRunTotals(activities, start, end);
      const runRows = Object.entries(
        aggregateSportTotals(activities, start, end).by_type,
      )
        .filter(([type]) => PACE_ACTIVITY_TYPES.has(type))
        .map(([, row]) => row);
      const sum = (key: "count" | "moving_time_s" | "load") =>
        runRows.reduce((acc, row) => acc + row[key], 0);

      expect(sum("count"), start).toBe(runTotals.runs);
      expect(sum("moving_time_s"), start).toBe(runTotals.moving_time_s);
      expect(sum("load"), start).toBe(runTotals.load);
    }
  });
});

describe("formatAthleteStatsText", () => {
  it("renders one line per bucket with no emoji or Strava wording", () => {
    const activities = [run({ start_date_local: "2026-09-21T07:00:00" })];
    const totals = aggregateRunTotals(activities, "2026-09-21", "2026-09-24");
    const sports = aggregateSportTotals(activities, "2026-09-21", "2026-09-24");
    const text = formatAthleteStatsText({
      this_week: totals,
      last_4_weeks: totals,
      this_month: totals,
      ytd: totals,
      last_year_to_date: aggregateRunTotals([], "2025-01-01", "2025-09-24"),
      all_sports: {
        this_week: sports,
        last_4_weeks: sports,
        this_month: sports,
        ytd: sports,
        last_year_to_date: {
          total: aggregateSportTotals([], "2025-01-01", "2025-09-24").total,
        },
      },
      units: { distance: "km", pace: "min/km", time: "s", elevation: "m" },
    });

    expect(text).toContain("This week:");
    expect(text).toContain("Last 4 weeks:");
    expect(text).toContain("This month:");
    expect(text).toContain("YTD:");
    expect(text).toContain("Last year to date:");
    expect(text).toContain(
      "YTD change on last year to date: runs +1, distance +5 km, time +25:00, load +40",
    );
    expect(text).toContain(
      "YTD change on last year to date: activities +1, time +25:00, load +40",
    );
    expect(text).not.toMatch(/Strava/i);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("getAthleteStatsTool.execute", () => {
  beforeEach(() => {
    mockedListActivities.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches from 1 January last year through today", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([]);

    await getAthleteStatsTool.execute({}, "key");

    expect(mockedListActivities).toHaveBeenCalledWith(
      "key",
      { oldest: "2025-01-01", newest: "2026-09-24" },
      expect.any(Function),
    );
  });

  it("reaches back to 1 January last year, past early January's rolling 28 days", async () => {
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([]);

    await getAthleteStatsTool.execute({}, "key");

    expect(mockedListActivities).toHaveBeenCalledWith(
      "key",
      { oldest: "2025-01-01", newest: "2026-01-05" },
      expect.any(Function),
    );
  });

  it("totals last year to date for the same dates, with 29 February as 28 February", async () => {
    vi.setSystemTime(new Date("2028-02-29T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([
      run({ id: "a", start_date_local: "2027-01-01T07:00:00" }),
      run({ id: "b", start_date_local: "2027-02-28T07:00:00" }),
      run({ id: "c", type: "Ride", start_date_local: "2027-02-28T09:00:00" }),
      run({ id: "d", start_date_local: "2027-03-01T07:00:00" }),
      run({ id: "e", start_date_local: "2026-12-31T07:00:00" }),
      run({ id: "f", start_date_local: "2028-02-29T07:00:00" }),
    ] as IntervalsActivity[]);

    const result = await getAthleteStatsTool.execute({}, "key");

    expect(mockedListActivities).toHaveBeenCalledWith(
      "key",
      { oldest: "2027-01-01", newest: "2028-02-29" },
      expect.any(Function),
    );
    const structured = result.structuredContent;
    expect(structured?.last_year_to_date.runs).toBe(2);
    expect(structured?.ytd.runs).toBe(1);
    expect(structured?.all_sports.last_year_to_date.total.count).toBe(3);
    expect(structured?.all_sports.last_year_to_date).not.toHaveProperty(
      "by_type",
    );
    expect(result.content[0]?.text).toContain(
      "YTD change on last year to date: runs -1,",
    );
  });

  it("aggregates the activities fixture into week and month buckets", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await getAthleteStatsTool.execute({}, "key");

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent;
    expect(structured?.this_week).toEqual({
      runs: 2,
      distance_km: 14.07,
      moving_time_s: 4277,
      moving_time: "1:11:17",
      elevation_gain_m: 156,
      load: 93,
      average_pace_min_per_km: "5:04",
      calories: 1030,
      calories_missing: 0,
      longest_run: {
        id: "i189807578",
        date: "2026-09-24",
        distance_km: 8.03,
      },
    });
    expect(structured?.this_month).toEqual({
      runs: 9,
      distance_km: 60.13,
      moving_time_s: 18484,
      moving_time: "5:08:04",
      elevation_gain_m: 669,
      load: 406,
      average_pace_min_per_km: "5:07",
      calories: 4388,
      calories_missing: 0,
      longest_run: {
        id: "i189757183",
        date: "2026-09-19",
        distance_km: 11.03,
      },
    });
    expect(structured?.units).toEqual({
      distance: "km",
      pace: "min/km",
      time: "s",
      elevation: "m",
    });
  });

  it("adds all-sports totals for the same periods", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await getAthleteStatsTool.execute({}, "key");

    const structured = result.structuredContent;
    expect(structured?.all_sports.this_week).toEqual({
      total: {
        count: 4,
        moving_time_s: 11071,
        load: 133,
        calories: 1748,
        calories_missing: 0,
      },
      by_type: {
        Run: {
          count: 2,
          moving_time_s: 4277,
          distance_km: 14.07,
          load: 93,
          calories: 1030,
        },
        Pilates: {
          count: 1,
          moving_time_s: 3444,
          distance_km: null,
          load: 22,
          calories: 359,
        },
        WeightTraining: {
          count: 1,
          moving_time_s: 3350,
          distance_km: null,
          load: 18,
          calories: 359,
        },
      },
    });
    expect(Object.keys(structured?.all_sports.ytd.by_type ?? {})).toEqual([
      "Run",
      "Swim",
      "WeightTraining",
      "Pilates",
    ]);
    expect(structured?.all_sports.ytd.total).toEqual({
      count: 16,
      moving_time_s: 38377,
      load: 543,
      calories: 6671,
      calories_missing: 0,
    });
    expect(AthleteStatsOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("keeps the four all-sports periods apart", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([
      run({ id: "i1", start_date_local: "2026-09-22T07:00:00" }),
      run({
        id: "i2",
        type: "Swim",
        start_date_local: "2026-09-02T07:00:00",
      }),
      run({
        id: "i3",
        type: "OpenWaterSwim",
        start_date_local: "2026-08-30T07:00:00",
      }),
      run({
        id: "i4",
        type: "Ride",
        start_date_local: "2026-03-01T07:00:00",
      }),
    ] as IntervalsActivity[]);

    const result = await getAthleteStatsTool.execute({}, "key");

    const all = result.structuredContent?.all_sports;
    expect(all?.this_week.total.count).toBe(1);
    expect(all?.this_month.total.count).toBe(2);
    expect(all?.last_4_weeks.total.count).toBe(3);
    expect(all?.ytd.total.count).toBe(4);
    expect(Object.keys(all?.ytd.by_type ?? {}).sort()).toEqual([
      "OpenWaterSwim",
      "Ride",
      "Run",
      "Swim",
    ]);
    expect(all?.ytd.by_type.Ride).toEqual({
      count: 1,
      moving_time_s: 1500,
      distance_km: 5,
      load: 40,
      calories: null,
    });
  });

  it("renders the all-sports block after the run totals", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await getAthleteStatsTool.execute({}, "key");

    const text = result.content[0]?.text ?? "";
    const expectedInOrder = [
      "Run totals (run-only load)",
      "All sports (whole-body load)",
      "This week: 4 activities, 3:04:31, load 133",
      "  Run: 2 activities, 14.07 km, 1:11:17, load 93",
      "  Pilates: 1 activity, 57:24, load 22",
      "Last 4 weeks: 16 activities, 10:39:37, load 543",
      "  Swim: 2 activities, 3.00 km, 48:29, load 53",
    ];
    let from = 0;
    for (const line of expectedInOrder) {
      const at = text.indexOf(line, from);
      expect(at, line).toBeGreaterThanOrEqual(0);
      from = at + line.length;
    }
    // A type with no distance shows none.
    expect(text).not.toMatch(/Pilates: [^\n]*km/);
  });

  it("renders an empty period as 0 activities with no type lines", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getAthleteStatsTool.execute({}, "key");

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "This week: 0 activities, 0:00, load 0, 0 kcal\nLast 4 weeks: 0 activities, 0:00, load 0, 0 kcal",
    );
    expect(result.structuredContent?.all_sports.ytd).toEqual({
      total: {
        count: 0,
        moving_time_s: 0,
        load: 0,
        calories: 0,
        calories_missing: 0,
      },
      by_type: {},
    });
  });

  it("totals a range to match summing list-activities over the same dates", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockImplementation(async (_key, range) =>
      fixture.filter((a) => {
        const date = a.start_date_local.slice(0, 10);
        return date >= range.oldest && date <= range.newest;
      }),
    );
    const dates = { oldest: "2026-09-08", newest: "2026-09-20" };

    const stats = (await getAthleteStatsTool.execute(dates, "key"))
      .structuredContent?.range;
    const listed =
      (await listActivitiesTool.execute({ ...dates, limit: 200 }, "key"))
        .structuredContent?.activities ?? [];

    expect(stats?.oldest).toBe(dates.oldest);
    expect(stats?.newest).toBe(dates.newest);
    const runs = listed.filter((a) => PACE_ACTIVITY_TYPES.has(a.type));
    expect(runs.length).toBeGreaterThan(1);
    expect(stats?.runs.runs).toBe(runs.length);
    expect(stats?.runs.distance_km).toBeCloseTo(
      runs.reduce((sum, a) => sum + (a.distance_km ?? 0), 0),
      1,
    );
    expect(stats?.runs.moving_time_s).toBe(
      runs.reduce((sum, a) => sum + a.moving_time_s, 0),
    );
    expect(stats?.all_sports.total.count).toBe(listed.length);
    expect(stats?.all_sports.total.moving_time_s).toBe(
      listed.reduce((sum, a) => sum + a.moving_time_s, 0),
    );
    const longest = [...runs].sort(
      (x, y) => (y.distance_km ?? 0) - (x.distance_km ?? 0),
    )[0];
    expect(stats?.runs.longest_run).toEqual({
      id: longest?.id,
      date: longest?.date,
      distance_km: longest?.distance_km,
    });
    // Inside the fixed periods' read, so no second request.
    expect(mockedListActivities).toHaveBeenCalledTimes(2);
  });

  it("reads a range over 366 days outside the fixed periods in its own request", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([]).mockResolvedValueOnce([
      run({ id: "a", start_date_local: "2021-12-31T07:00:00" }),
      run({
        id: "b",
        start_date_local: "2020-01-01T07:00:00",
        distance: 42_195,
        calories: 3000,
      }),
      run({ id: "c", type: "Swim", start_date_local: "2020-06-01T07:00:00" }),
    ] as IntervalsActivity[]);

    const result = await getAthleteStatsTool.execute(
      { oldest: "2020-01-01", newest: "2021-12-31" },
      "key",
    );

    expect(mockedListActivities).toHaveBeenLastCalledWith(
      "key",
      { oldest: "2020-01-01", newest: "2021-12-31" },
      expect.any(Function),
    );
    const range = result.structuredContent?.range;
    expect(range?.runs.runs).toBe(2);
    expect(range?.runs.longest_run).toEqual({
      id: "b",
      date: "2020-01-01",
      distance_km: 42.2,
    });
    expect(range?.all_sports.total.count).toBe(3);
    // Only b reports calories: the totals count the other two as missing.
    expect(range?.runs.calories_missing).toBe(1);
    expect(range?.all_sports.total).toMatchObject({
      calories: 3000,
      calories_missing: 2,
    });
    expect(range?.all_sports.by_type.Swim?.calories).toBeNull();
    expect(result.structuredContent?.ytd.runs).toBe(0);
    expect(
      AthleteStatsOutputSchema.safeParse(result.structuredContent).success,
    ).toBe(true);
    expect(result.content[0]?.text).toContain(
      "2020-01-01 to 2021-12-31: 2 runs, 47.20 km, 50:00, 1:04 /km avg, +100 m, load 80, 3000 kcal (1 missing), longest 42.20 km on 2020-01-01 [b]",
    );
  });

  it("leaves range out without oldest, and refuses newest alone or reversed", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValue([]);

    const plain = await getAthleteStatsTool.execute({}, "key");
    expect(plain.structuredContent).not.toHaveProperty("range");

    const alone = await getAthleteStatsTool.execute(
      { newest: "2026-03-31" },
      "key",
    );
    expect(alone.isError).toBe(true);
    expect(alone.content[0]?.text).toContain("newest needs oldest");

    const reversed = await getAthleteStatsTool.execute(
      { oldest: "2026-03-31", newest: "2026-03-01" },
      "key",
    );
    expect(reversed.isError).toBe(true);
    expect(mockedListActivities).toHaveBeenCalledTimes(1);
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockRejectedValueOnce(
      handledRateLimit("listActivities"),
    );

    const result = await getAthleteStatsTool.execute({}, "key");

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("❌")).toBe(true);
    expect(text).toContain("Retry-After: 60s");
  });
});
