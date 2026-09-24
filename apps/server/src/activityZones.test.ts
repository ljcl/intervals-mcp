import { describe, expect, it } from "vitest";
import { hrZoneMismatchWarning, mapIntervalsZones } from "./activityZones";
import { type IntervalsActivity } from "./intervalsClient";

function activity(
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  return {
    id: "i1",
    start_date_local: "2026-07-10T06:12:00",
    ...overrides,
  } as IntervalsActivity;
}

describe("mapIntervalsZones", () => {
  it("maps HR bounds/times with a real, non-open-ended top zone", () => {
    const sets = mapIntervalsZones(
      activity({
        icu_hr_zones: [120, 145, 160, 175, 197],
        icu_hr_zone_times: [600, 1800, 900, 500, 200],
      }),
    );
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    expect(set.type).toBe("heartrate");
    expect(set.unit).toBe("bpm");
    expect(set.sensorBased).toBeNull();
    expect(set.totalSeconds).toBe(4000);
    expect(set.buckets).toHaveLength(5);
    expect(set.buckets[0]).toEqual({
      zone: 1,
      min: 0,
      max: 120,
      seconds: 600,
      pct: 15,
    });
    // The top zone keeps its real upper bound, unlike Strava's -1 sentinel.
    expect(set.buckets[4]).toEqual({
      zone: 5,
      min: 175,
      max: 197,
      seconds: 200,
      pct: 5,
    });
  });

  it("maps power from icu_power_zones + icu_zone_times when both are present", () => {
    const sets = mapIntervalsZones(
      activity({
        icu_power_zones: [200, 400],
        icu_zone_times: [
          { id: "z1", secs: 1000 },
          { id: "z2", secs: 500 },
        ],
      }),
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]!.type).toBe("power");
    expect(sets[0]!.unit).toBe("W");
    expect(sets[0]!.buckets[1]).toEqual({
      zone: 2,
      min: 200,
      max: 400,
      seconds: 500,
      pct: expect.closeTo(33.3, 1),
    });
  });

  it("includes both HR and power sets when both are present", () => {
    const sets = mapIntervalsZones(
      activity({
        icu_hr_zones: [120, 197],
        icu_hr_zone_times: [100, 100],
        icu_power_zones: [200, 400],
        icu_zone_times: [
          { id: "z1", secs: 100 },
          { id: "z2", secs: 100 },
        ],
      }),
    );
    expect(sets.map((s) => s.type)).toEqual(["heartrate", "power"]);
  });

  it("omits power when icu_zone_times is missing even if icu_power_zones is present", () => {
    const sets = mapIntervalsZones(
      activity({ icu_power_zones: [200, 400], icu_zone_times: null }),
    );
    expect(sets).toEqual([]);
  });

  it("omits HR when bounds and times counts don't match", () => {
    const sets = mapIntervalsZones(
      activity({
        icu_hr_zones: [120, 145, 197],
        icu_hr_zone_times: [100, 100],
      }),
    );
    expect(sets).toEqual([]);
  });

  it("omits HR when nothing was recorded", () => {
    expect(
      mapIntervalsZones(
        activity({
          icu_hr_zones: [120, 197],
          icu_hr_zone_times: [0, 0],
        }),
      ),
    ).toEqual([]);
  });

  it("returns an empty array when the activity has no zone data at all", () => {
    expect(mapIntervalsZones(activity())).toEqual([]);
  });
});

describe("hrZoneMismatchWarning", () => {
  it("is null when HR bounds and times match", () => {
    expect(
      hrZoneMismatchWarning(
        activity({
          icu_hr_zones: [120, 197],
          icu_hr_zone_times: [100, 100],
        }),
      ),
    ).toBeNull();
  });

  it("is null when the activity has no HR zone data", () => {
    expect(hrZoneMismatchWarning(activity())).toBeNull();
  });

  it("names both counts when bounds and times disagree", () => {
    const warning = hrZoneMismatchWarning(
      activity({
        icu_hr_zones: [120, 145, 197],
        icu_hr_zone_times: [100, 100],
      }),
    );
    expect(warning).toContain("3 zones");
    expect(warning).toContain("2 zones");
  });
});
