import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAthletePaceCurves,
  type IntervalsAthletePaceCurves,
} from "../intervalsClient";
import { getRacePredictionTool } from "./getRacePrediction";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getAthletePaceCurves: vi.fn() };
});

const mockedAthleteCurves = vi.mocked(getAthletePaceCurves);

/** Today, so fixture dates can be built relative to a run date. */
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]!;

/**
 * A minimal athlete pace-curves response: one point per curve at the given
 * distance/time, both owned by the same activity dated `days` ago. Stands in
 * for what `getAthletePaceCurves(curves: ["all", "90d"])` returns.
 */
function curvesWithPoint(
  distanceMeters: number,
  elapsedSeconds: number,
  options: { days?: number; activityId?: string; name?: string } = {},
): IntervalsAthletePaceCurves {
  const { days = 20, activityId = "i1", name = "Run 1" } = options;
  return {
    list: [
      {
        id: "all",
        distance: [distanceMeters],
        values: [elapsedSeconds],
        activity_id: [activityId],
      },
      {
        id: "90d",
        distance: [distanceMeters],
        values: [elapsedSeconds],
        activity_id: [activityId],
      },
    ],
    activities: {
      [activityId]: {
        id: activityId,
        name,
        start_date_local: `${daysAgo(days)}T08:00:00`,
        race: false,
      },
    },
  } as unknown as IntervalsAthletePaceCurves;
}

const run = (args: Record<string, unknown> = {}) =>
  getRacePredictionTool.execute(
    args as Parameters<typeof getRacePredictionTool.execute>[0],
    "test-token",
  );

type RunResult = Awaited<ReturnType<typeof run>>;
type Structured = NonNullable<RunResult["structuredContent"]>;

/** Narrow past the optional structuredContent so assertions read cleanly. */
function payload(result: RunResult): Structured {
  const structured = result.structuredContent;
  if (!structured) throw new Error("expected structuredContent");
  return structured;
}

function prediction(result: RunResult, distance: string) {
  const found = payload(result).predictions.find(
    (p) => p.distance === distance,
  );
  if (!found) throw new Error(`no prediction for ${distance}`);
  return found;
}

function target(result: RunResult) {
  const found = payload(result).target;
  if (!found) throw new Error("expected a target race");
  return found;
}

describe("getRacePredictionTool.execute", () => {
  beforeEach(() => {
    mockedAthleteCurves.mockReset();
  });

  it("fetches the all and 90d pace curves for Run", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    await run();

    expect(mockedAthleteCurves).toHaveBeenCalledWith("test-token", {
      type: "Run",
      curves: ["all", "90d"],
    });
  });

  it("predicts the four standard distances from one 10K pace-curve point", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run();

    const labels = payload(result).predictions.map((p) => p.distance);
    expect(labels).toEqual(["5K", "10K", "Half Marathon", "Marathon"]);

    // The 10K prediction is the source time itself.
    const tenK = prediction(result, "10K");
    expect(tenK.predicted_seconds).toBe(2400);
    expect(tenK.predicted_formatted).toBe("40:00");
    expect(tenK.pace_min_per_km).toBe("4:00");
    expect(tenK.pace_sec_per_km).toBe(240);
    expect(tenK.primary_source.name).toBe("10000 m");

    expect(result.content[0]?.text).toContain("Race prediction");
    expect(result.content[0]?.text).toContain("Equivalent performances");
  });

  it("excludes pace-curve points shorter than the Riegel floor from the inputs", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          id: "all",
          distance: [400, 5000],
          values: [70, 1200],
          activity_id: ["i1", "i2"],
        },
        {
          id: "90d",
          distance: [400, 5000],
          values: [70, 1200],
          activity_id: ["i1", "i2"],
        },
      ],
      activities: {
        i1: { id: "i1", name: "Run 1", start_date_local: "2026-06-01" },
        i2: { id: "i2", name: "Run 2", start_date_local: "2026-06-01" },
      },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await run();

    const sourceNames = payload(result).sources.map((source) => source.name);
    expect(sourceNames).toEqual(["5000 m"]);
  });

  it("reports a helpful message when no usable pace-curve points exist", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        { id: "all", distance: [], values: [], activity_id: [] },
        { id: "90d", distance: [], values: [], activity_id: [] },
      ],
      activities: {},
    } as unknown as IntervalsAthletePaceCurves);

    const result = await run();

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.predictions).toEqual([]);
    expect(result.structuredContent?.target).toBeNull();
    expect(result.content[0]?.text).toContain("Not enough to predict from");
  });

  it("builds km even and negative-split tables for the requested race, no mile splits", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run({ raceDistance: "Half Marathon" });

    const race = target(result);
    expect(race.distance).toBe("Half Marathon");
    expect(race.basis).toBe("predicted");
    expect(race.goal_vs_predicted_seconds).toBeNull();

    const strategies = race.splits.map((s) => `${s.unit}:${s.strategy}`);
    expect(strategies).toEqual(["km:even", "km:negative"]);
    expect(race.splits.every((s) => s.unit === "km")).toBe(true);

    // A half is 21.0975 km: 21 full kilometres plus a partial.
    expect(race.splits[0]?.splits).toHaveLength(22);
    expect(result.content[0]?.text).toContain("Even splits - kilometres");
    expect(result.content[0]?.text).toContain("Negative split");
    expect(result.content[0]?.text).not.toContain("mile");
  });

  it("paces the splits to a goal time and grades it against the prediction", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run({
      raceDistance: "Half Marathon",
      goalTime: "1:45:00",
    });

    const race = target(result);
    expect(race.basis).toBe("goal");
    expect(race.total_seconds).toBe(6300);
    expect(race.total_formatted).toBe("1:45:00");
    expect(race.splits[0]?.total_seconds).toBe(6300);
    // 40:00 for 10K predicts ~1:29 for a half, so 1:45 is conservative.
    expect(race.goal_vs_predicted_seconds).toBeGreaterThan(0);
    expect(race.goal_assessment).toContain("conservative");
  });

  it("calls a goal within 2% of the prediction realistic, not conservative", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    // 40:00 for 10K predicts 40:00 for 10K, so 40:20 is 0.8% slower.
    const result = await run({ raceDistance: "10K", goalTime: "40:20" });

    const race = target(result);
    expect(race.goal_vs_predicted_seconds).toBe(20);
    expect(race.goal_assessment).toContain("right on what your efforts");
    expect(race.goal_assessment).not.toContain("conservative");
  });

  it("warns when the goal is far faster than the prediction", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run({
      raceDistance: "Half Marathon",
      goalTime: "1:15:00",
    });

    const race = target(result);
    expect(race.goal_vs_predicted_seconds).toBeLessThan(0);
    expect(race.goal_assessment).toContain("risks blowing up");
  });

  it("rejects an unparseable goal time before fetching pace curves", async () => {
    const result = await run({ raceDistance: "10K", goalTime: "soon" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Could not read");
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
  });

  it("adds a non-standard requested race to the prediction table", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run({ raceDistance: "15K" });

    const labels = payload(result).predictions.map((p) => p.distance);
    // Inserted in distance order, not appended.
    expect(labels).toEqual(["5K", "10K", "15K", "Half Marathon", "Marathon"]);
  });

  it("prompts for raceDistance when only predictions were asked for", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run();

    expect(result.structuredContent?.target).toBeNull();
    expect(result.content[0]?.text).toContain("Pass raceDistance");
  });

  it("weights the fastest-of-90d point over a stale all-time PR and says which drove it", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          // A blistering 10K from two years ago.
          id: "all",
          distance: [10000],
          values: [2100],
          activity_id: ["i1"],
        },
        {
          // A slower one from last week.
          id: "90d",
          distance: [10000],
          values: [2500],
          activity_id: ["i2"],
        },
      ],
      activities: {
        i1: { id: "i1", name: "Old PR", start_date_local: daysAgo(730) },
        i2: { id: "i2", name: "Recent run", start_date_local: daysAgo(7) },
      },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await run();

    const tenK = prediction(result, "10K");
    expect(tenK.primary_source.activity_id).toBe("i2");
    // The stale PR still contributes, so the consensus sits between them.
    expect(tenK.predicted_seconds).toBeLessThan(2500);
    expect(tenK.predicted_seconds).toBeGreaterThan(2100);
    expect(tenK.spread?.range_seconds).toBe(400);
  });

  it("grades a marathon predicted only from a 5K as low confidence", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(5000, 1200));

    const result = await run();

    const marathon = prediction(result, "Marathon");
    expect(marathon.confidence).toBe("low");
    expect(marathon.confidence_notes.join(" ")).toContain(
      "beyond your longest",
    );
  });

  it("reports the critical-speed model and a per-distance CS prediction alongside Riegel, falling back to all when 90d has no fit", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          id: "all",
          distance: [10000],
          values: [2400],
          activity_id: ["i1"],
          paceModels: [
            { type: "CS", criticalSpeed: 3.6, dPrime: 120, r2: 0.995 },
          ],
        },
        {
          id: "90d",
          distance: [10000],
          values: [2400],
          activity_id: ["i1"],
        },
      ],
      activities: {
        i1: { id: "i1", name: "Run 1", start_date_local: daysAgo(20) },
      },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await run();

    const model = payload(result).critical_speed_model;
    expect(model).not.toBeNull();
    expect(model?.d_prime_m).toBe(120);
    expect(model?.r2).toBe(0.995);
    expect(model?.source).toBe("all");

    const tenK = prediction(result, "10K");
    // (10000 - 120) / 3.6 = 2744.4...
    expect(tenK.critical_speed?.predicted_seconds).toBe(2744);
    expect(tenK.critical_speed?.within_model_range).toBe(true);

    const marathon = prediction(result, "Marathon");
    // (42195 - 120) / 3.6 is well over an hour: outside the model's window.
    expect(marathon.critical_speed?.within_model_range).toBe(false);
    expect(result.content[0]?.text).toContain("critical speed");
    expect(result.content[0]?.text).toContain(
      "outside the model's 3-60 minute validity window",
    );
  });

  it("prefers the 90d curve's critical-speed fit over all's when both are present", async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: [
        {
          id: "all",
          distance: [10000],
          values: [2400],
          activity_id: ["i1"],
          paceModels: [
            { type: "CS", criticalSpeed: 3.6, dPrime: 120, r2: 0.995 },
          ],
        },
        {
          id: "90d",
          distance: [10000],
          values: [2400],
          activity_id: ["i1"],
          paceModels: [
            { type: "CS", criticalSpeed: 3.9, dPrime: 100, r2: 0.99 },
          ],
        },
      ],
      activities: {
        i1: { id: "i1", name: "Run 1", start_date_local: daysAgo(20) },
      },
    } as unknown as IntervalsAthletePaceCurves);

    const result = await run();

    const model = payload(result).critical_speed_model;
    expect(model?.source).toBe("90d");
    expect(model?.d_prime_m).toBe(100);
    expect(result.content[0]?.text).toContain(
      "Critical speed model (intervals.icu, 90d curve)",
    );
  });

  it("leaves critical_speed_model null and per-prediction critical_speed null when no CS fit is present", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(curvesWithPoint(10000, 2400));

    const result = await run();

    expect(payload(result).critical_speed_model).toBeNull();
    const tenK = prediction(result, "10K");
    expect(tenK.critical_speed).toBeNull();
  });

  it("returns an isError result with the prefixed text on a client failure", async () => {
    mockedAthleteCurves.mockRejectedValueOnce(new Error("network down"));

    const result = await run();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌/);
    expect(result.content[0]?.text).toContain("network down");
  });
});
