import { beforeEach, describe, expect, it, vi } from "vitest";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import activityPaceCurvesFixture from "../__fixtures__/intervals/activity-pace-curves.json";
import paceCurvesFixture from "../__fixtures__/intervals/pace-curves.json";
import {
  getActivity,
  getActivityPaceCurves,
  getAthletePaceCurves,
  type IntervalsActivity,
  type IntervalsActivityPaceCurves,
  type IntervalsAthletePaceCurves,
} from "../intervalsClient";
import {
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
    getActivityPaceCurves: vi.fn(),
    getActivity: vi.fn(),
  };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedAthleteCurves = vi.mocked(getAthletePaceCurves);
const mockedActivityCurves = vi.mocked(getActivityPaceCurves);
const mockedGetActivity = vi.mocked(getActivity);

const paceCurves = paceCurvesFixture as unknown as IntervalsAthletePaceCurves;
const activityCurves =
  activityPaceCurvesFixture as unknown as IntervalsActivityPaceCurves;
const activities = activitiesFixture as unknown as IntervalsActivity[];

beforeEach(() => {
  mockedAthleteCurves.mockReset();
  mockedActivityCurves.mockReset();
  mockedGetActivity.mockReset();
});

const activityById = new Map(activities.map((a) => [a.id, a]));

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

describe("getBestEffortsTool.execute", () => {
  it("topN=1 (default): fetches the athlete pace curve for the default window and distances", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(paceCurves);

    const result = await getBestEffortsTool.execute(
      { window: "1y", topN: 1 },
      "k",
    );

    expect(mockedAthleteCurves).toHaveBeenCalledWith("k", {
      type: "Run",
      curves: ["1y"],
    });
    expect(mockedActivityCurves).not.toHaveBeenCalled();
    expect(mockedGetActivity).not.toHaveBeenCalled();

    const content = result.structuredContent as {
      window: { id: string };
      top_n: number;
      units: { time: string; pace: string };
      best_efforts: Record<
        string,
        Array<{
          rank: number;
          time_seconds: number;
          pace_min_per_km: string | null;
          activity_id: string;
          activity_name: string;
          date: string;
          race: boolean;
        }>
      >;
    };
    expect(content.window.id).toBe("1y");
    expect(content.top_n).toBe(1);
    expect(content.units).toEqual({ time: "s", pace: "min/km" });

    const oneKm = content.best_efforts["1km"];
    expect(oneKm).toHaveLength(1);
    expect(oneKm?.[0]).toMatchObject({
      rank: 1,
      time_seconds: 248,
      // 248 s over 1000 m = 4:08/km, bare (unit is in the field name/units block).
      pace_min_per_km: "4:08",
      activity_id: "i189757802",
      activity_name: "Run 22",
      date: "2026-06-25",
      race: false,
    });

    const marathon = content.best_efforts.marathon;
    expect(marathon?.[0]).toMatchObject({
      time_seconds: 13711,
      activity_id: "i189757207",
    });

    expect(result.content[0]?.text).toContain("1km:");
    expect(result.content[0]?.text).toContain("recorded time stream");
  });

  it("topN>1: fetches activity pace curves, then resolves winning activity names/race flags with one getActivity call per unique id, never listActivities", async () => {
    mockedActivityCurves.mockResolvedValueOnce(activityCurves);
    mockedGetActivity.mockImplementation(async (_apiKey, id) => {
      const activity = activityById.get(id);
      if (!activity) throw new Error(`no fixture activity for ${id}`);
      return activity;
    });

    const result = await getBestEffortsTool.execute(
      { distances: ["1km"], window: "2026-09-01..2026-09-24", topN: 2 },
      "k",
    );

    expect(mockedAthleteCurves).not.toHaveBeenCalled();
    expect(mockedActivityCurves).toHaveBeenCalledWith("k", {
      oldest: "2026-09-01",
      newest: "2026-09-24",
      type: "Run",
      distances: [1000],
    });
    // Exactly one getActivity call per winning activity id, never a
    // listActivities-style sweep over the whole window.
    expect(mockedGetActivity).toHaveBeenCalledTimes(2);
    expect(mockedGetActivity).toHaveBeenCalledWith("k", "i189757188");
    expect(mockedGetActivity).toHaveBeenCalledWith("k", "i189757183");

    const content = result.structuredContent as {
      best_efforts: Record<
        string,
        Array<{
          rank: number;
          time_seconds: number;
          activity_id: string;
          activity_name: string;
        }>
      >;
    };
    const oneKm = content.best_efforts["1km"];
    expect(oneKm).toHaveLength(2);
    expect(oneKm?.[0]).toMatchObject({
      rank: 1,
      time_seconds: 269,
      activity_id: "i189757188",
      activity_name: "Run 10",
    });
    expect(oneKm?.[1]).toMatchObject({
      rank: 2,
      time_seconds: 280,
      activity_id: "i189757183",
      activity_name: "Run 5",
    });
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

    const content = result.structuredContent as {
      warnings: string[];
      missing: string[];
      best_efforts: Record<string, unknown[]>;
    };
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
        },
      ],
      activities: { i1: { id: "i1", name: "Short run", race: false } },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["5km", "marathon"], window: "1y", topN: 1 },
      "k",
    );

    const content = result.structuredContent as {
      missing: string[];
      warnings: string[];
      best_efforts: Record<string, Array<{ activity_id: string }>>;
    };
    // The 5K itself still matches (within tolerance).
    expect(content.best_efforts["5km"]).toHaveLength(1);
    expect(content.best_efforts["5km"]?.[0]?.activity_id).toBe("i1");
    // But the marathon must NOT be mislabelled with that same 5K point.
    expect(content.best_efforts.marathon).toEqual([]);
    expect(content.missing).toEqual(["marathon"]);
    expect(content.warnings.some((w) => w.includes("marathon"))).toBe(true);
  });

  it("bounds the topN>1 curve lookup to the same tolerance", async () => {
    mockedActivityCurves.mockResolvedValueOnce({
      distances: [5000],
      gap: false,
      curves: [
        { id: "i1", start_date_local: "2026-09-01", weight: 70, secs: [1200] },
      ],
    } as unknown as IntervalsActivityPaceCurves);

    const result = await getBestEffortsTool.execute(
      { distances: ["marathon"], window: "2026-08-01..2026-09-01", topN: 2 },
      "k",
    );

    const content = result.structuredContent as {
      missing: string[];
      best_efforts: Record<string, unknown[]>;
    };
    expect(content.best_efforts.marathon).toEqual([]);
    expect(content.missing).toEqual(["marathon"]);
    // No candidates within tolerance means no winning ids, so no name lookup.
    expect(mockedGetActivity).not.toHaveBeenCalled();
  });

  it("topN>1 caps name lookups at the number of unique winning activity ids across all requested distances, never per-distance duplicates", async () => {
    mockedActivityCurves.mockResolvedValueOnce({
      distances: [1000, 5000],
      gap: false,
      curves: [
        {
          id: "i189757188",
          start_date_local: "2026-09-10",
          weight: 70,
          secs: [269, 1300],
        },
        {
          id: "i189757183",
          start_date_local: "2026-09-05",
          weight: 70,
          secs: [280, 1400],
        },
      ],
    } as unknown as IntervalsActivityPaceCurves);
    mockedGetActivity.mockImplementation(async (_apiKey, id) => {
      const activity = activityById.get(id);
      if (!activity) throw new Error(`no fixture activity for ${id}`);
      return activity;
    });

    await getBestEffortsTool.execute(
      {
        distances: ["1km", "5km"],
        window: "2026-09-01..2026-09-24",
        topN: 2,
      },
      "k",
    );

    // Both activities place in both distances; still one lookup per unique id.
    expect(mockedGetActivity).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid window without calling the client", async () => {
    const result = await getBestEffortsTool.execute(
      { window: "not-a-window", topN: 1 },
      "k",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
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

describe("formatBestEffortsText", () => {
  it("reports no best efforts when every distance is empty", () => {
    const text = formatBestEffortsText(
      {
        window: { id: "1y", oldest: "2025-09-25", newest: "2026-09-25" },
        top_n: 1,
        units: { time: "s", pace: "min/km" },
        note: "note",
        best_efforts: {},
        missing: [],
        warnings: [],
      },
      ["400m"],
    );
    expect(text).toContain("No best efforts found");
  });
});
