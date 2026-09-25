import { describe, expect, it } from "vitest";
import { buildCadenceTrendData } from "./cadenceTrendData";
import { type IntervalsActivity } from "./intervalsClient";

function activity(
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  return {
    id: "i1",
    name: "Easy Run",
    type: "Run",
    start_date_local: "2026-06-01T07:00:00",
    distance: 8000,
    moving_time: 2400,
    average_cadence: 84,
    average_speed: 3.33,
    ...overrides,
  } as IntervalsActivity;
}

describe("buildCadenceTrendData", () => {
  it("keeps only run types and drops the rest", () => {
    const result = buildCadenceTrendData(
      [activity(), activity({ id: "i2", type: "Ride" })],
      { weeks: 4 },
    );

    expect(result.weeks).toBe(4);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.id).toBe("i1");
  });

  it("keeps Run/TrailRun/VirtualRun", () => {
    const result = buildCadenceTrendData(
      [
        activity({ id: "i1", type: "Run" }),
        activity({ id: "i2", type: "TrailRun" }),
        activity({ id: "i3", type: "VirtualRun" }),
        activity({ id: "i4", type: "Walk" }),
      ],
      { weeks: 4 },
    );

    expect(result.activities.map((a) => a.id)).toEqual(["i1", "i2", "i3"]);
  });

  it("doubles cadence to steps/min via activityCadenceSpm", () => {
    const result = buildCadenceTrendData([activity({ average_cadence: 84 })], {
      weeks: 4,
    });

    expect(result.activities[0]?.averageCadence).toBe(168);
  });

  it("returns 0 cadence, not a dropped run, when average_cadence is missing", () => {
    const result = buildCadenceTrendData(
      [activity({ average_cadence: null })],
      { weeks: 4 },
    );

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.averageCadence).toBe(0);
  });

  it("derives pace in decimal minutes/km from average_speed", () => {
    const result = buildCadenceTrendData([activity({ average_speed: 3.33 })], {
      weeks: 4,
    });

    // 1000 / 3.33 / 60 ≈ 5.005
    expect(result.activities[0]?.averagePace).toBeCloseTo(5.01, 2);
  });

  it("carries the intervals id through as a string", () => {
    const result = buildCadenceTrendData([activity({ id: "i189807578" })], {
      weeks: 4,
    });

    expect(result.activities[0]?.id).toBe("i189807578");
    expect(typeof result.activities[0]?.id).toBe("string");
  });

  it("reads the local calendar date without a UTC shift for a late-evening run", () => {
    // A run at 23:30 local time must stay on that calendar day: no `Z`
    // suffix means this must never round-trip through `new Date()`.
    const result = buildCadenceTrendData(
      [activity({ start_date_local: "2026-06-01T23:30:00" })],
      { weeks: 4 },
    );

    expect(result.activities[0]?.date).toBe("2026-06-01");
  });

  it("converts distance to km rounded to 2dp", () => {
    const result = buildCadenceTrendData([activity({ distance: 8123.456 })], {
      weeks: 4,
    });

    expect(result.activities[0]?.distance).toBe(8.12);
  });
});
