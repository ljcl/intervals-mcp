import { describe, expect, it } from "vitest";
import {
  hrZoneMismatchWarning,
  mapIntervalsZones,
  resolveHrZones,
} from "./activityZones";
import {
  type IntervalsActivity,
  type IntervalsSportSettings,
} from "./intervalsClient";

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

  it("drops power zones even when icu_power_zones + icu_zone_times are both present (see docs/api-notes.md)", () => {
    const sets = mapIntervalsZones(
      activity({
        icu_power_zones: [200, 400],
        icu_zone_times: [
          { id: "z1", secs: 1000 },
          { id: "z2", secs: 500 },
        ],
      }),
    );
    expect(sets).toEqual([]);
  });

  it("reports HR only when both HR and power data are present", () => {
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
    expect(sets.map((s) => s.type)).toEqual(["heartrate"]);
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

describe("resolveHrZones", () => {
  const RUN_GROUP = {
    types: ["Run", "VirtualRun", "TrailRun"],
    hr_zones: [130, 150, 165, 180, 200],
  } as IntervalsSportSettings;
  const TIMES = [600, 1800, 900, 500, 200];

  it("prefers the activity's own bounds", () => {
    const resolved = resolveHrZones(
      activity({
        icu_hr_zones: [120, 145, 160, 175, 197],
        icu_hr_zone_times: TIMES,
      }),
      RUN_GROUP,
      "Run",
    );
    expect(resolved.source).toBe("activity");
    expect(resolved.set?.buckets[0]?.max).toBe(120);
  });

  it("falls back to the Run group when the activity has no bounds and the group covers its type", () => {
    const resolved = resolveHrZones(
      activity({ icu_hr_zone_times: TIMES }),
      RUN_GROUP,
      "TrailRun",
    );
    expect(resolved.source).toBe("sport_settings");
    expect(resolved.set?.buckets[0]?.max).toBe(130);
  });

  it("does not fall back for a type the group does not cover", () => {
    const resolved = resolveHrZones(
      activity({ icu_hr_zone_times: TIMES }),
      RUN_GROUP,
      "Walk",
    );
    expect(resolved.set).toBeNull();
    expect(resolved.note).toContain("unavailable");
  });

  it("does not fall back when the activity's own bounds do not match its times", () => {
    const resolved = resolveHrZones(
      activity({ icu_hr_zones: [120, 145, 160], icu_hr_zone_times: TIMES }),
      RUN_GROUP,
      "Run",
    );
    expect(resolved.set).toBeNull();
    expect(resolved.note).toContain("do not match");
  });

  it("refuses fallback bounds with a different zone count", () => {
    const resolved = resolveHrZones(
      activity({ icu_hr_zone_times: [600, 1800, 900] }),
      RUN_GROUP,
      "Run",
    );
    expect(resolved.set).toBeNull();
    expect(resolved.note).toContain("(5 zones)");
  });

  it("has no set and no note when nothing was recorded", () => {
    expect(resolveHrZones(activity(), RUN_GROUP, "Run")).toEqual({
      set: null,
      source: null,
      note: null,
    });
  });
});
