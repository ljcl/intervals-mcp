import { describe, expect, it } from "vitest";
import paceActivityFixture from "./__fixtures__/intervals/activity-pace-zones.json";
import {
  hrZoneMismatchWarning,
  mapIntervalsZones,
  resolveHrZones,
  zoneRanges,
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

describe("zoneRanges", () => {
  it("starts zone 1 at 0 and each later zone at the previous upper bound", () => {
    expect(zoneRanges([142, 154, 190])).toEqual([
      { zone: 1, min: 0, max: 142 },
      { zone: 2, min: 142, max: 154 },
      { zone: 3, min: 154, max: 190 },
    ]);
  });

  it("gives no ranges for no bounds", () => {
    expect(zoneRanges([])).toEqual([]);
  });
});

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

describe("mapIntervalsZones pace set", () => {
  // activity-pace-zones.json: a run with pace_zones, threshold_pace
  // 3.5714285 m/s, use_gap_zone_times true, and 7 pace and GAP buckets.
  const run = paceActivityFixture as unknown as IntervalsActivity;
  const paceOf = (a: IntervalsActivity) =>
    mapIntervalsZones(a).find((set) => set.type === "pace");

  it("builds the pace set after heart rate, from GAP when the activity's setting says so", () => {
    const sets = mapIntervalsZones(run);
    expect(sets.map((s) => s.type)).toEqual(["heartrate", "pace"]);
    const pace = sets[1]!;
    expect(pace.basis).toBe("gap");
    expect(pace.unit).toBe("m/s");
    expect(pace.buckets.map((b) => b.seconds)).toEqual(run.gap_zone_times);
    expect(pace.totalSeconds).toBe(1716);
  });

  it("turns percentages of threshold speed into speeds, open at both ends", () => {
    const { buckets } = paceOf(run)!;
    // Zone 1 starts at 0, 77.5% of 3.5714285 m/s ends it; 999% is the open top.
    expect(buckets[0]).toMatchObject({ min: 0, max: 2.768 });
    expect(buckets[3]).toMatchObject({ min: 3.368, max: 3.571 });
    expect(buckets[6]).toMatchObject({ min: 3.982, max: null });
  });

  it("reads pace_zone_times, labelled pace, when use_gap_zone_times is not set", () => {
    const pace = paceOf({ ...run, use_gap_zone_times: false })!;
    expect(pace.basis).toBe("pace");
    expect(pace.buckets.map((b) => b.seconds)).toEqual(run.pace_zone_times);
  });

  it("falls back to pace time, labelled pace, when GAP time was not recorded", () => {
    const pace = paceOf({ ...run, gap_zone_times: null })!;
    expect(pace.basis).toBe("pace");
  });

  it("gives a run without heart rate its pace set alone", () => {
    const sets = mapIntervalsZones({
      ...run,
      icu_hr_zones: null,
      icu_hr_zone_times: null,
    });
    expect(sets.map((s) => s.type)).toEqual(["pace"]);
  });

  it("has no pace set without a threshold pace, bounds, or matching times", () => {
    expect(paceOf({ ...run, threshold_pace: null })).toBeUndefined();
    expect(paceOf({ ...run, pace_zones: null })).toBeUndefined();
    expect(paceOf({ ...run, gap_zone_times: [1, 2] })).toBeUndefined();
    expect(
      paceOf({ ...run, gap_zone_times: [0, 0, 0, 0, 0, 0, 0] }),
    ).toBeUndefined();
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
