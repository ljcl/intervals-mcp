import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import { type IntervalsActivity, listActivities } from "../intervalsClient";
import {
  aggregateRunTotals,
  formatAthleteStatsText,
  getAthleteStatsTool,
  startOfMonth,
  startOfYear,
} from "./getAthleteStats";

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
    });
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

describe("formatAthleteStatsText", () => {
  it("renders one line per bucket with no emoji or Strava wording", () => {
    const totals = aggregateRunTotals(
      [run({ start_date_local: "2026-09-21T07:00:00" })],
      "2026-09-21",
      "2026-09-24",
    );
    const text = formatAthleteStatsText({
      this_week: totals,
      last_4_weeks: totals,
      this_month: totals,
      ytd: totals,
      units: { distance: "km", pace: "min/km", time: "s", elevation: "m" },
    });

    expect(text).toContain("This week:");
    expect(text).toContain("Last 4 weeks:");
    expect(text).toContain("This month:");
    expect(text).toContain("YTD:");
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

  it("fetches from 1 January through today mid-year", async () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([]);

    await getAthleteStatsTool.execute({}, "key");

    expect(mockedListActivities).toHaveBeenCalledWith("key", {
      oldest: "2026-01-01",
      newest: "2026-09-24",
    });
  });

  it("extends the fetch window past 1 January in early January for the rolling 28 days", async () => {
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    mockedListActivities.mockResolvedValueOnce([]);

    await getAthleteStatsTool.execute({}, "key");

    expect(mockedListActivities).toHaveBeenCalledWith("key", {
      oldest: "2025-12-09",
      newest: "2026-01-05",
    });
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
    });
    expect(structured?.this_month).toEqual({
      runs: 9,
      distance_km: 60.13,
      moving_time_s: 18484,
      moving_time: "5:08:04",
      elevation_gain_m: 669,
      load: 406,
      average_pace_min_per_km: "5:07",
    });
    expect(structured?.units).toEqual({
      distance: "km",
      pace: "min/km",
      time: "s",
      elevation: "m",
    });
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
    expect(text).toContain("rate limit");
  });
});
