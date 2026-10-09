import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import paceCurvesFixture from "../__fixtures__/intervals/pace-curves.json";
import paceCurvesSubmaxFixture from "../__fixtures__/intervals/pace-curves-submax.json";
import streamsTimeDistanceFixture from "../__fixtures__/intervals/streams-time-distance.json";
import {
  getActivity,
  getActivityStreams,
  getAthletePaceCurves,
  type IntervalsActivity,
  type IntervalsAthletePaceCurves,
  type IntervalsStream,
} from "../intervalsClient";
import {
  type BestEffortEntry,
  formatBestEffortsText,
  getBestEffortsTool,
  matchDistance,
  nearestIndex,
  resolveWindow,
} from "./getBestEfforts";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return {
    ...actual,
    getAthletePaceCurves: vi.fn(),
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
  };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedAthleteCurves = vi.mocked(getAthletePaceCurves);
const mockedGetActivity = vi.mocked(getActivity);
const mockedStreams = vi.mocked(getActivityStreams);

const paceCurves = paceCurvesFixture as unknown as IntervalsAthletePaceCurves;
const paceCurvesSubmax =
  paceCurvesSubmaxFixture as unknown as IntervalsAthletePaceCurves;
const timeDistanceStreams = streamsTimeDistanceFixture as IntervalsStream[];

/** The run `streams-time-distance.json` and `activity-pace-curve.json` were
 * read from (6,119.64 m), on the `activity.json` row. */
const RUN_ID = "i193700503";
const run = {
  ...activityFixture,
  id: RUN_ID,
  name: "Run 5",
  type: "Run",
  start_date_local: "2026-10-05T17:51:05",
  race: false,
} as unknown as IntervalsActivity;

beforeEach(() => {
  mockedAthleteCurves.mockReset();
  mockedGetActivity.mockReset();
  mockedStreams.mockReset();
});

type Structured = {
  mode: "window" | "activity";
  window: { id: string; oldest: string; newest: string } | null;
  activity: {
    id: string;
    name: string;
    date: string;
    type: string;
    covered_km: number;
  } | null;
  top_n: number;
  units: Record<string, string>;
  note: string;
  best_efforts: Record<string, BestEffortEntry[]>;
  missing: string[];
  warnings: string[];
};

const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Structured;

/** The best-efforts response `formatBestEffortsText` takes. */
type Response = Parameters<typeof formatBestEffortsText>[0];

describe("resolveWindow", () => {
  it('maps "all" to intervals.icu\'s own lower bound, through today', () => {
    const result = resolveWindow("all", "UTC");
    if ("error" in result) throw new Error("expected a resolved window");
    expect(result.curveId).toBe("all");
    expect(result.oldest).toBe("1986-01-01");
  });

  it('maps "1y" to 365 days before today, curveId "1y"', () => {
    const result = resolveWindow("1y", "UTC");
    if ("error" in result) throw new Error("expected a resolved window");
    expect(result.curveId).toBe("1y");
    // 366 calendar days inclusive (oldest through newest), matching the
    // intervals.icu "1y" curve's own `days: 366`.
    const days =
      (Date.parse(`${result.newest}T00:00:00Z`) -
        Date.parse(`${result.oldest}T00:00:00Z`)) /
        86_400_000 +
      1;
    expect(days).toBe(366);
  });

  it('maps "90d" to 90 days before today, curveId "90d"', () => {
    const result = resolveWindow("90d", "UTC");
    if ("error" in result) throw new Error("expected a resolved window");
    expect(result.curveId).toBe("90d");
    const days =
      (Date.parse(`${result.newest}T00:00:00Z`) -
        Date.parse(`${result.oldest}T00:00:00Z`)) /
        86_400_000 +
      1;
    expect(days).toBe(91);
  });

  it("maps a custom YYYY-MM-DD..YYYY-MM-DD range to an r.<oldest>.<newest> curve id", () => {
    const result = resolveWindow("2026-01-01..2026-03-01", "UTC");
    if ("error" in result) throw new Error("expected a resolved window");
    expect(result).toEqual({
      curveId: "r.2026-01-01.2026-03-01",
      oldest: "2026-01-01",
      newest: "2026-03-01",
    });
  });

  it("rejects a custom range with an invalid calendar date", () => {
    const result = resolveWindow("2026-02-30..2026-03-01", "UTC");
    expect("error" in result).toBe(true);
  });

  it("rejects a custom range where oldest is after newest", () => {
    const result = resolveWindow("2026-03-01..2026-01-01", "UTC");
    expect("error" in result).toBe(true);
  });

  it("rejects an unrecognised window string", () => {
    const result = resolveWindow("last month", "UTC");
    expect("error" in result).toBe(true);
  });
});

describe("nearestIndex", () => {
  it("finds the exact match when present", () => {
    expect(nearestIndex([400, 1000, 5000], 1000)).toBe(1);
  });

  it("finds the closest point when there is no exact match", () => {
    expect(nearestIndex([400, 1000, 21000, 21097.5, 22000], 21097.5)).toBe(3);
  });

  it("returns null for an empty array", () => {
    expect(nearestIndex([], 1000)).toBeNull();
  });
});

describe("matchDistance", () => {
  it("matches an exact point", () => {
    expect(matchDistance([400, 1000, 5000], 1000)).toBe(1);
  });

  it("matches a point within the larger of 2% or 50m", () => {
    // 42195 target, tolerance = max(42195*0.02, 50) = 843.9; 42000 is 195m off.
    expect(matchDistance([42000], 42195)).toBe(0);
    // 400 target, tolerance = max(8, 50) = 50; 440 is 40m off.
    expect(matchDistance([440], 400)).toBe(0);
  });

  it("rejects the closest point when it is further than tolerance away", () => {
    // A 5K point is the "closest" available to a marathon target on a
    // sparse curve, but 37195 m away, nowhere near the 843.9 m tolerance.
    expect(matchDistance([5000], 42195)).toBeNull();
    // 400 target, tolerance 50m; 500 is 100m off.
    expect(matchDistance([500], 400)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(matchDistance([], 1000)).toBeNull();
  });
});

describe("getBestEffortsTool.execute over a window", () => {
  it("topN=1 (default): fetches the athlete pace curve for the default window and distances", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(paceCurves);

    const result = await getBestEffortsTool.execute(
      { window: "1y", topN: 1 },
      "k",
    );

    // Exactly the plain read: no subMaxEfforts, so the URL and cache key
    // are the same as before #82.
    expect(mockedAthleteCurves).toHaveBeenCalledWith("k", {
      type: "Run",
      curves: ["1y"],
    });
    expect(mockedGetActivity).not.toHaveBeenCalled();
    expect(mockedStreams).not.toHaveBeenCalled();

    const content = structured(result);
    expect(content.mode).toBe("window");
    expect(content.activity).toBeNull();
    expect(content.window?.id).toBe("1y");
    expect(content.top_n).toBe(1);
    expect(content.units).toEqual({ time: "s", pace: "min/km" });

    const oneKm = content.best_efforts["1km"];
    expect(oneKm).toHaveLength(1);
    expect(oneKm?.[0]).toEqual({
      rank: 1,
      time_seconds: 248,
      time_formatted: "4:08",
      // 248 s over 1000 m = 4:08/km, bare (unit is in the field name/units block).
      pace_min_per_km: "4:08",
      distance_m: 1000,
      activity_id: "i189757802",
      activity_name: "Run 22",
      date: "2026-06-25",
      race: false,
      start_km: null,
      end_km: null,
      stopped_seconds: null,
    });

    const marathon = content.best_efforts.marathon;
    expect(marathon?.[0]).toMatchObject({
      time_seconds: 13711,
      activity_id: "i189757207",
    });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("1km:");
    expect(text).toContain("elapsed time across the fastest stretch");
    expect(text).not.toContain("moving-time");
  });

  it('defaults to the "1y" curve when neither window nor id is sent', async () => {
    mockedAthleteCurves.mockResolvedValueOnce(paceCurves);

    await getBestEffortsTool.execute({ topN: 1 }, "k");

    expect(mockedAthleteCurves).toHaveBeenCalledWith("k", {
      type: "Run",
      curves: ["1y"],
    });
  });

  it("topN>1: reads the next ranks from the same request (subMaxEfforts), names and dates from its activities map", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(paceCurvesSubmax);

    const result = await getBestEffortsTool.execute(
      { distances: ["5km"], window: "2026-08-01..2026-09-30", topN: 3 },
      "k",
    );

    expect(mockedAthleteCurves).toHaveBeenCalledTimes(1);
    expect(mockedAthleteCurves).toHaveBeenCalledWith("k", {
      type: "Run",
      curves: ["r.2026-08-01.2026-09-30"],
      subMaxEfforts: 2,
    });
    // No name lookups: before #82 each winning activity cost one.
    expect(mockedGetActivity).not.toHaveBeenCalled();
    expect(mockedStreams).not.toHaveBeenCalled();

    const fiveK = structured(result).best_efforts["5km"];
    expect(
      fiveK?.map((e) => [e.rank, e.time_seconds, e.activity_name, e.date]),
    ).toEqual([
      [1, 1361, "Run 20", "2026-08-09"],
      [2, 1372, "Run 16", "2026-08-13"],
      [3, 1400, "Run 11", "2026-08-20"],
    ]);
    expect(new Set(fiveK?.map((e) => e.activity_id)).size).toBe(3);
    expect(structured(result).warnings).toEqual([]);

    expect(result.content[0]?.text).toContain(
      [
        "5km:",
        "  1. 22:41 (4:32 min/km) - 2026-08-09",
        "     Run 20",
        "  2. 22:52 (4:34 min/km) - 2026-08-13",
        "     Run 16",
        "  3. 23:20 (4:40 min/km) - 2026-08-20",
        "     Run 11",
      ].join("\n"),
    );
  });

  it("topN>1: lists only the ranks intervals.icu has at a distance (rows are truncated where fewer runs reach it)", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(paceCurvesSubmax);

    const result = await getBestEffortsTool.execute(
      {
        distances: ["5km", "marathon"],
        window: "2026-08-01..2026-09-30",
        topN: 5,
      },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts["5km"]?.map((e) => e.time_seconds)).toEqual([
      1361, 1372, 1400, 1437, 1453,
    ]);
    expect(content.best_efforts.marathon).toHaveLength(1);
    expect(content.best_efforts.marathon?.[0]?.time_seconds).toBe(13711);
    expect(content.missing).toEqual([]);
  });

  it("never lists one activity twice at a distance", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          id: "1y",
          distance: [1000],
          values: [250],
          activity_id: ["i1"],
          submax_values: [[255], [260]],
          submax_activity_id: [["i1"], ["i2"]],
        },
      ],
      activities: {},
    } as unknown as IntervalsAthletePaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["1km"], window: "1y", topN: 3 },
      "k",
    );

    expect(
      structured(result).best_efforts["1km"]?.map((e) => [
        e.rank,
        e.activity_id,
        e.time_seconds,
      ]),
    ).toEqual([
      [1, "i1", 250],
      [2, "i2", 260],
    ]);
  });

  it('falls back to "Unknown activity" when the activities map has no entry, with no extra request', async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        { id: "1y", distance: [1000], values: [269], activity_id: ["i999"] },
      ],
      activities: {},
    } as unknown as IntervalsAthletePaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["1km"], window: "1y", topN: 1 },
      "k",
    );

    expect(structured(result).best_efforts["1km"]?.[0]).toMatchObject({
      activity_name: "Unknown activity",
      date: "",
      race: false,
    });
    expect(mockedGetActivity).not.toHaveBeenCalled();
  });

  it("topN>1 with no ranks below 1 in the response: shows the best and says why", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(paceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["1km"], window: "1y", topN: 3 },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts["1km"]).toHaveLength(1);
    expect(content.warnings).toEqual([
      "intervals.icu returned no ranks below the best for this window, so only the best is shown.",
    ]);
  });

  it("warns and returns an empty list when the requested curve id is missing from the response", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [],
      activities: {},
    } as unknown as IntervalsAthletePaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["marathon"], window: "1y", topN: 1 },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts.marathon).toEqual([]);
    expect(content.missing).toEqual(["marathon"]);
    expect(content.warnings.length).toBeGreaterThan(0);
  });

  it("bounds the curve lookup to a tolerance: a sparse window with only a 5K point does not mislabel it as the marathon best effort", async () => {
    // Only a single, short curve point: a 5K, nowhere near a marathon.
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          id: "1y",
          distance: [5000],
          values: [1200],
          activity_id: ["i1"],
          submax_values: [[1250]],
          submax_activity_id: [["i2"]],
        },
      ],
      activities: { i1: { id: "i1", name: "Short run", race: false } },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["5km", "marathon"], window: "1y", topN: 2 },
      "k",
    );

    const content = structured(result);
    // The 5K itself still matches (within tolerance), at both ranks.
    expect(content.best_efforts["5km"]?.map((e) => e.activity_id)).toEqual([
      "i1",
      "i2",
    ]);
    // But the marathon must NOT be mislabelled with that same 5K point.
    expect(content.best_efforts.marathon).toEqual([]);
    expect(content.missing).toEqual(["marathon"]);
    expect(content.warnings.some((w) => w.includes("marathon"))).toBe(true);
  });

  it("names the curve point a time covers when it is not the label's distance", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          id: "1y",
          distance: [41842.84],
          values: [14000],
          activity_id: ["i1"],
        },
      ],
      activities: { i1: { id: "i1", name: "Long run", race: true } },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["marathon"], window: "1y", topN: 1 },
      "k",
    );

    expect(structured(result).best_efforts.marathon?.[0]?.distance_m).toBe(
      41842.84,
    );
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("marathon (41.84 km):");
    expect(text).toContain("(race)");
  });

  it("a rate limit on the curve read fails the call with the rate-limit text", async () => {
    mockedAthleteCurves.mockRejectedValueOnce(
      handledRateLimit("getAthletePaceCurves for 1y"),
    );

    const result = await getBestEffortsTool.execute(
      { window: "1y", topN: 3 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌ .*rate limit/i);
  });

  it("rejects an invalid window without calling the client", async () => {
    const result = await getBestEffortsTool.execute(
      { window: "2026-03-01..2026-01-01", topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌ window oldest/);
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
  });

  it("returns an isError result with the prefixed text on a client failure", async () => {
    mockedAthleteCurves.mockRejectedValueOnce(new Error("boom"));

    const result = await getBestEffortsTool.execute(
      { window: "1y", topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌/);
  });
});

describe("getBestEffortsTool.execute with an id", () => {
  beforeEach(() => {
    mockedGetActivity.mockResolvedValue(run);
    mockedStreams.mockResolvedValue(timeDistanceStreams);
  });

  it("searches the run's own streams for the distances it covers", async () => {
    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("k", RUN_ID);
    expect(mockedStreams).toHaveBeenCalledWith("k", RUN_ID, [
      "time",
      "distance",
      "velocity_smooth",
    ]);
    expect(mockedAthleteCurves).not.toHaveBeenCalled();

    const content = structured(result);
    expect(content.mode).toBe("activity");
    expect(content.window).toBeNull();
    expect(content.activity).toEqual({
      id: RUN_ID,
      name: "Run 5",
      date: "2026-10-05",
      type: "Run",
      covered_km: 6.11,
    });
    // 10 km and longer do not fit a 6.1 km run and were not asked for.
    expect(Object.keys(content.best_efforts)).toEqual(["400m", "1km", "5km"]);
    expect(content.missing).toEqual([]);
    expect(content.warnings).toEqual([]);
    expect(content.best_efforts["5km"]?.[0]).toEqual({
      rank: 1,
      time_seconds: 1625,
      time_formatted: "27:05",
      pace_min_per_km: "5:25",
      distance_m: 5000,
      date: "2026-10-05",
      activity_id: RUN_ID,
      activity_name: "Run 5",
      race: false,
      start_km: 0.87,
      end_km: 5.87,
      stopped_seconds: 0,
    });

    expect(result.content[0]?.text).toBe(
      [
        `Best efforts inside Run 5 (${RUN_ID}), 2026-10-05, 6.11 km`,
        "400m:",
        "  1. 1:59 (4:58 min/km) from km 0.26 to 0.66",
        "1km:",
        "  1. 5:12 (5:12 min/km) from km 1.43 to 2.43",
        "5km:",
        "  1. 27:05 (5:25 min/km) from km 0.87 to 5.87",
        "Each time is the elapsed time across the fastest stretch, the rule intervals.icu's pace curves use. A stop inside a stretch counts toward its time.",
      ].join("\n"),
    );
  });

  it("lists an asked distance longer than the run in missing, with the run's length", async () => {
    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["5km", "10km"], topN: 1 },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts["5km"]).toHaveLength(1);
    expect(content.best_efforts["10km"]).toEqual([]);
    expect(content.missing).toEqual(["10km"]);
    expect(content.warnings).toEqual([
      "10km is longer than this run (6.11 km).",
    ]);
  });

  it("topN picks the fastest stretches that do not overlap", async () => {
    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["1km"], topN: 3 },
      "k",
    );

    expect(
      structured(result).best_efforts["1km"]?.map((e) => [
        e.rank,
        e.time_seconds,
        e.start_km,
      ]),
    ).toEqual([
      [1, 312, 1.43],
      [2, 315, 3.4],
      [3, 320, 4.98],
    ]);
  });

  it("warns when the run is shorter than every default distance", async () => {
    mockedStreams.mockResolvedValueOnce([
      { type: "time", data: [0, 60, 120] },
      { type: "distance", data: [0, 150, 300] },
    ]);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts).toEqual({});
    expect(content.warnings).toEqual([
      "This run covers 0.30 km, shorter than the shortest distance (400m).",
    ]);
    expect(result.content[0]?.text).toContain(
      "No best efforts found for the requested distances.",
    );
  });

  it("refuses an activity that is not a run, before reading streams", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      ...run,
      type: "Ride",
      name: "Commute",
    } as IntervalsActivity);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `❌ get-best-efforts searches runs only (Run, TrailRun, VirtualRun). Activity ${RUN_ID} ("Commute") is a Ride.`,
    );
    expect(mockedStreams).not.toHaveBeenCalled();
  });

  it("says a run with no recorded streams has no best efforts", async () => {
    mockedStreams.mockResolvedValueOnce([]);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /^❌ No data streams are recorded for "Run 5"/,
    );
  });

  it("says a run with no distance stream has no best efforts", async () => {
    mockedStreams.mockResolvedValueOnce([{ type: "time", data: [0, 1, 2] }]);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `❌ "Run 5" (activity ${RUN_ID}) has no distance stream, so there are no best efforts to find.`,
    );
  });

  it("reports a missing activity as not found", async () => {
    mockedGetActivity.mockReset();
    mockedGetActivity.mockRejectedValueOnce(handledNotFound("getActivity"));

    const result = await getBestEffortsTool.execute(
      { id: "i404", topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("❌ Activity i404 was not found.");
  });

  it("a rate limit on the stream read fails the call", async () => {
    mockedStreams.mockReset();
    mockedStreams.mockRejectedValueOnce(
      handledRateLimit(`getActivityStreams for ID ${RUN_ID}`),
    );

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌ Rate limit reached/);
  });

  it("leaves out the parts the athlete marked to ignore for pace", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      ...run,
      ignore_parts: [{ start_index: 455, end_index: 500, pace: true }],
    } as IntervalsActivity);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["1km"], topN: 1 },
      "k",
    );

    const content = structured(result);
    // Without the part, rank 1 is samples 455 to 767 (km 1.43, 312 s).
    // Now the fastest one starts after the part (sample 532, km 1.68).
    expect(content.best_efforts["1km"]?.[0]?.start_km).toBe(1.68);
    expect(content.best_efforts["1km"]?.[0]?.time_seconds).toBe(313);
    expect(content.warnings).toEqual([
      "Left out 1 part of this run that you marked in intervals.icu to ignore for pace.",
    ]);
  });

  it("does not apply ignored parts when the loader dropped a sample, and says so", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      ...run,
      ignore_parts: [{ start_index: 455, end_index: 500, pace: true }],
    } as IntervalsActivity);
    // One sample with no time, far after the fastest 1 km.
    const time = timeDistanceStreams[0]!.data.slice();
    time[1500] = null;
    mockedStreams.mockResolvedValueOnce([
      { type: "time", data: time },
      timeDistanceStreams[1]!,
    ]);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["1km"], topN: 1 },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts["1km"]?.[0]?.start_km).toBe(1.43);
    expect(content.warnings).toEqual([
      "This run has 1 part marked in intervals.icu to ignore for pace. They were not left out: 1 sample has no time, so their positions in the streams are not certain.",
    ]);
  });

  it("says when intervals.icu ignores the whole run's pace", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      ...run,
      ignore_pace: true,
    } as IntervalsActivity);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["1km"], topN: 1 },
      "k",
    );

    expect(structured(result).warnings).toEqual([
      "This run is marked in intervals.icu to ignore its pace, so intervals.icu may leave it out of your pace curves.",
    ]);
  });

  it("lists a distance in missing when every stretch of it touches an ignored part", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      ...run,
      ignore_parts: [{ start_index: 0, end_index: 1986, pace: true }],
    } as IntervalsActivity);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["1km"], topN: 1 },
      "k",
    );

    const content = structured(result);
    expect(content.best_efforts["1km"]).toEqual([]);
    expect(content.missing).toEqual(["1km"]);
    expect(content.warnings).toEqual([
      "Left out 1 part of this run that you marked in intervals.icu to ignore for pace.",
      "No 1km stretch outside the ignored parts.",
    ]);
  });

  it("counts a stand at 1 Hz (auto-pause off) as stopped, from the speed stream", async () => {
    // 6 km at 4 m/s, sampled every second, with a 120 s stand at 0 m/s
    // from second 600: no gap in the time stream marks it.
    const time: number[] = [];
    const distanceM: number[] = [];
    const speed: number[] = [];
    let metres = 0;
    for (let t = 0; t <= 1620; t += 1) {
      const standing = t >= 600 && t < 720;
      if (t > 0 && !standing) metres += 4;
      time.push(t);
      distanceM.push(metres);
      speed.push(standing ? 0 : 4);
    }
    mockedStreams.mockResolvedValueOnce([
      { type: "time", data: time },
      { type: "distance", data: distanceM },
      { type: "velocity_smooth", data: speed },
    ]);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["5km"], topN: 1 },
      "k",
    );

    // Every 5 km stretch holds the stand: 1,250 s running plus 120 s.
    const [best] = structured(result).best_efforts["5km"] ?? [];
    expect(best?.time_seconds).toBe(1370);
    expect(best?.stopped_seconds).toBe(120);
    expect(result.content[0]?.text).toContain(
      "  1. 22:50 (4:34 min/km) from km 0.00 to 5.00, 2:00 stopped",
    );
  });

  it("names a default distance the run is just short of, and rounds its length down", async () => {
    // A 5K that the distance stream ends 3 m short of.
    mockedStreams.mockResolvedValueOnce([
      { type: "time", data: [0, 600, 1200, 1500] },
      { type: "distance", data: [0, 2000, 4000, 4997] },
    ]);

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 1 },
      "k",
    );

    const content = structured(result);
    expect(content.activity?.covered_km).toBe(4.99);
    expect(Object.keys(content.best_efforts)).toEqual(["400m", "1km"]);
    expect(content.missing).toEqual([]);
    expect(content.warnings).toEqual([
      "5km was not searched: this run covers 4.99 km, 3 m short of it.",
    ]);
    expect(result.content[0]?.text).toContain(
      `Best efforts inside Run 5 (${RUN_ID}), 2026-10-05, 4.99 km`,
    );

    mockedStreams.mockResolvedValueOnce([
      { type: "time", data: [0, 600, 1200, 1500] },
      { type: "distance", data: [0, 2000, 4000, 4997] },
    ]);
    const asked = await getBestEffortsTool.execute(
      { id: RUN_ID, distances: ["5km"], topN: 1 },
      "k",
    );
    expect(structured(asked).warnings).toEqual([
      "5km is longer than this run (4.99 km).",
    ]);
  });
});

describe("inputSchema", () => {
  const schema = getBestEffortsTool.inputSchema;

  it("refuses id and window together, at window", () => {
    const parsed = schema.safeParse({ id: "i1", window: "1y" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["window"]);
    expect(parsed.error?.issues[0]?.message).toMatch(
      /^Send id or window, not both/,
    );
  });

  it("takes either one alone, and applies no window default", () => {
    expect(schema.parse({})).toEqual({ topN: 1 });
    expect(schema.parse({ id: 12345 })).toEqual({ id: "12345", topN: 1 });
    expect(schema.parse({ id: "latest", topN: 3 })).toEqual({
      id: "latest",
      topN: 3,
    });
  });
});

describe("formatBestEffortsText", () => {
  const base: Response = {
    mode: "window",
    window: { id: "1y", oldest: "2025-09-25", newest: "2026-09-25" },
    activity: null,
    top_n: 1,
    units: { time: "s", pace: "min/km" },
    note: "note",
    best_efforts: {},
    missing: [],
    warnings: [],
  };

  it("reports no best efforts when every distance is empty", () => {
    const text = formatBestEffortsText(base, ["400m"]);
    expect(text).toContain("No best efforts found");
  });

  it("gives where an effort was inside the run, and its stopped time", () => {
    const text = formatBestEffortsText(
      {
        ...base,
        mode: "activity",
        window: null,
        activity: {
          id: "i1",
          name: "Long run",
          date: "2026-10-04",
          type: "Run",
          covered_km: 21.24,
        },
        best_efforts: {
          "10km": [
            {
              rank: 1,
              time_seconds: 2973,
              time_formatted: "49:33",
              pace_min_per_km: "4:57",
              distance_m: 10000,
              date: "2026-10-04",
              activity_id: "i1",
              activity_name: "Long run",
              race: false,
              start_km: 10.16,
              end_km: 20.16,
              stopped_seconds: 41,
            },
          ],
        },
      },
      ["10km"],
    );

    expect(text.split("\n").slice(0, 3)).toEqual([
      "Best efforts inside Long run (i1), 2026-10-04, 21.24 km",
      "10km:",
      "  1. 49:33 (4:57 min/km) from km 10.16 to 20.16, 0:41 stopped",
    ]);
  });
});
