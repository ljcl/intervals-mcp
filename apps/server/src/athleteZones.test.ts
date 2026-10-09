import { describe, expect, it } from "vitest";
import hrCurvesFixture from "./__fixtures__/intervals/hr-curves.json";
import sportSettingsFixture from "./__fixtures__/intervals/sport-settings.json";
import {
  buildAthleteZones,
  checkLthr,
  checkMaxHr,
  type HrCurveRead,
  hrBests,
  lthrEstimate,
  mapHrZones,
  mapPaceZones,
  mapThresholdPace,
  resolveSportGroup,
} from "./athleteZones";
import {
  type IntervalsAthleteHrCurves,
  type IntervalsSportSettings,
} from "./intervalsClient";
import { AthleteZonesOutputSchema } from "./tools/outputs";

const groups = sportSettingsFixture as unknown as IntervalsSportSettings[];
const curves = hrCurvesFixture as unknown as IntervalsAthleteHrCurves;

const runGroup = groups.find((g) => g.types?.includes("Run"))!;
const swimGroup = groups.find((g) => g.types?.includes("Swim"))!;

/** A copy of the fixture curves with the value at one grid point replaced. */
function withValue(
  window: "90d" | "1y",
  secs: number,
  value: number | null,
  base: IntervalsAthleteHrCurves = curves,
): IntervalsAthleteHrCurves {
  const copy = structuredClone(base);
  const curve = copy.list.find((c) => c.id === window)!;
  curve.values[curve.secs.indexOf(secs)] = value;
  return copy;
}

/** A copy of the fixture curves with one window cut after `maxSecs`. */
function cutAt(
  window: "90d" | "1y",
  maxSecs: number,
): IntervalsAthleteHrCurves {
  const copy = structuredClone(curves);
  const curve = copy.list.find((c) => c.id === window)!;
  const keep = curve.secs.filter((s) => s <= maxSecs).length;
  curve.secs = curve.secs.slice(0, keep);
  curve.values = curve.values.slice(0, keep);
  curve.activity_id = curve.activity_id.slice(0, keep);
  return copy;
}

const read = (c: IntervalsAthleteHrCurves = curves): HrCurveRead => ({
  status: "read",
  curves: c,
});

describe("resolveSportGroup", () => {
  it("matches a group's type, ignoring case and spaces", () => {
    for (const sport of ["Run", "run", " RUN "]) {
      const resolved = resolveSportGroup(groups, sport);
      expect(resolved?.group).toBe(runGroup);
      expect(resolved?.sport).toBe("Run");
      expect(resolved?.defaultGroup).toBe(false);
    }
    const trail = resolveSportGroup(groups, "trail run");
    expect(trail?.group).toBe(runGroup);
    expect(trail?.sport).toBe("TrailRun");
  });

  it("gives a sport that no group lists the default Other group", () => {
    const resolved = resolveSportGroup(groups, "Rowing");
    expect(resolved?.group.other).toBe(true);
    expect(resolved?.sport).toBe("Rowing");
    expect(resolved?.defaultGroup).toBe(true);
  });

  it('matches "Other" to the Other group\'s own types', () => {
    const resolved = resolveSportGroup(groups, "Other");
    expect(resolved?.group.other).toBe(true);
    expect(resolved?.defaultGroup).toBe(false);
  });

  it("is null when no group covers the sport and there is no Other group", () => {
    const noOther = groups.filter((g) => g.other !== true);
    expect(resolveSportGroup(noOther, "Rowing")).toBeNull();
    expect(resolveSportGroup([], "Run")).toBeNull();
    // Words that are not activity types do not get the Other group.
    for (const word of ["Running", "Cycling", "Swimming", "Bike"]) {
      expect(resolveSportGroup(groups, word)).toBeNull();
    }
  });
});

describe("mapHrZones", () => {
  it("gives each zone its name and its range from the previous bound", () => {
    const zones = mapHrZones(runGroup);
    expect(zones).toHaveLength(5);
    expect(zones[0]).toEqual({
      zone: 1,
      name: "Very Easy",
      min_bpm: 0,
      max_bpm: 142,
    });
    expect(zones[1]).toMatchObject({ zone: 2, min_bpm: 142, max_bpm: 154 });
    expect(zones[4]?.max_bpm).toBe(190);
  });

  it("gives a zone with no name a null name", () => {
    const zones = mapHrZones({ ...runGroup, hr_zone_names: ["One"] });
    expect(zones[0]?.name).toBe("One");
    expect(zones[1]?.name).toBeNull();
  });

  it("gives no zones when the group has none", () => {
    expect(mapHrZones({ ...runGroup, hr_zones: null })).toEqual([]);
  });
});

describe("mapThresholdPace", () => {
  it("reads threshold_pace as a speed in m/s and gives pace per km", () => {
    expect(mapThresholdPace(runGroup)).toEqual({
      threshold_speed_mps: 3.571,
      threshold_pace_min_per_km: "4:40",
      threshold_pace_min_per_100m: null,
    });
  });

  it("adds pace per 100 m for a swim group", () => {
    expect(mapThresholdPace(swimGroup)).toEqual({
      threshold_speed_mps: 0.8,
      threshold_pace_min_per_km: "20:50",
      threshold_pace_min_per_100m: "2:05",
    });
  });

  it("gives no pace per 100 m below the apps' moving-speed floor", () => {
    expect(
      mapThresholdPace({ ...swimGroup, threshold_pace: 0.2 })
        .threshold_pace_min_per_100m,
    ).toBeNull();
  });

  it("is all null without a usable speed", () => {
    for (const value of [null, 0, -1, Number.NaN]) {
      expect(mapThresholdPace({ ...runGroup, threshold_pace: value })).toEqual({
        threshold_speed_mps: null,
        threshold_pace_min_per_km: null,
        threshold_pace_min_per_100m: null,
      });
    }
  });
});

describe("mapPaceZones", () => {
  it("turns percentages of threshold speed into pace ranges per km", () => {
    const zones = mapPaceZones(runGroup);
    expect(zones).toHaveLength(7);
    expect(
      zones.map((z) => [z.slowest_min_per_km, z.fastest_min_per_km]),
    ).toEqual([
      [null, "6:01"],
      ["6:01", "5:19"],
      ["5:19", "4:57"],
      ["4:57", "4:40"],
      ["4:40", "4:31"],
      ["4:31", "4:11"],
      ["4:11", null],
    ]);
    expect(zones[0]).toMatchObject({ zone: 1, name: "Zone 1", min_pct: 0 });
    // 999 is intervals.icu's open top.
    expect(zones[6]).toMatchObject({ min_pct: 111.5, max_pct: null });
    expect(zones.every((z) => z.slowest_min_per_100m === null)).toBe(true);
    expect(zones.every((z) => z.fastest_min_per_100m === null)).toBe(true);
  });

  it("adds pace per 100 m for a swim group", () => {
    const zones = mapPaceZones({ ...swimGroup, pace_zones: [77.5, 100, 999] });
    expect(
      zones.map((z) => [z.slowest_min_per_100m, z.fastest_min_per_100m]),
    ).toEqual([
      [null, "2:41"],
      ["2:41", "2:05"],
      ["2:05", null],
    ]);
    expect(zones[1]?.fastest_min_per_km).toBe("20:50");
  });

  it("keeps the percentages when no threshold pace is set", () => {
    const zones = mapPaceZones({ ...runGroup, threshold_pace: null });
    expect(zones[1]).toEqual({
      zone: 2,
      name: "Zone 2",
      min_pct: 77.5,
      max_pct: 87.7,
      slowest_min_per_km: null,
      fastest_min_per_km: null,
      slowest_min_per_100m: null,
      fastest_min_per_100m: null,
    });
  });

  it("gives no zones when the group has none", () => {
    expect(mapPaceZones({ ...runGroup, pace_zones: null })).toEqual([]);
  });
});

describe("hrBests", () => {
  it("reports the 20-, 30- and 60-minute bests of 90 days and the 60-s best of a year", () => {
    expect(hrBests(curves)).toEqual([
      {
        window: "90d",
        duration_s: 1200,
        bpm: 178,
        activity_id: "i300000002",
        date: "2026-08-30",
      },
      {
        window: "90d",
        duration_s: 1800,
        bpm: 175,
        activity_id: "i300000002",
        date: "2026-08-30",
      },
      {
        window: "90d",
        duration_s: 3600,
        bpm: 171,
        activity_id: "i300000003",
        date: "2026-09-21",
      },
      {
        window: "1y",
        duration_s: 60,
        bpm: 188,
        activity_id: "i300000004",
        date: "2026-03-08",
      },
    ]);
  });

  it("is empty for empty windows (intervals.icu leaves the curve out)", () => {
    expect(hrBests({ list: [], activities: {} })).toEqual([]);
  });

  it("leaves out durations past the longest activity in the window", () => {
    const durations = hrBests(cutAt("90d", 1560)).map(
      (b) => `${b.window}:${b.duration_s}`,
    );
    expect(durations).toEqual(["90d:1200", "1y:60"]);
  });

  it("leaves out a point with no value or a zero value", () => {
    expect(
      hrBests(withValue("90d", 1800, null)).map((b) => b.duration_s),
    ).toEqual([1200, 3600, 60]);
    expect(hrBests(withValue("90d", 1800, 0)).map((b) => b.duration_s)).toEqual(
      [1200, 3600, 60],
    );
  });

  it("gives a null date for an activity missing from the activities map", () => {
    const copy = structuredClone(curves);
    delete (copy.activities as Record<string, unknown>).i300000002;
    expect(hrBests(copy)[0]).toMatchObject({
      activity_id: "i300000002",
      date: null,
    });
  });
});

describe("lthrEstimate (intervals.icu's rule)", () => {
  it("takes 98% of the 20-minute best when that is higher", () => {
    // 98% of 178 is 174.44; the 60-minute best is 171.
    expect(lthrEstimate(curves)).toMatchObject({
      bpm: 174,
      basis: { duration_s: 1200, bpm: 178 },
    });
  });

  it("takes the 60-minute best when that is higher", () => {
    expect(lthrEstimate(withValue("90d", 3600, 176))).toMatchObject({
      bpm: 176,
      basis: { duration_s: 3600, bpm: 176 },
    });
  });

  it("prefers the 60-minute best on a tie", () => {
    expect(lthrEstimate(withValue("90d", 3600, 174))).toMatchObject({
      bpm: 174,
      basis: { duration_s: 3600 },
    });
  });

  it("uses the point that exists when the other is missing", () => {
    expect(lthrEstimate(cutAt("90d", 1560))).toMatchObject({
      bpm: 174,
      basis: { duration_s: 1200 },
    });
    expect(lthrEstimate(withValue("90d", 1200, null))).toMatchObject({
      bpm: 171,
      basis: { duration_s: 3600 },
    });
  });

  it("is null with neither point", () => {
    expect(lthrEstimate(cutAt("90d", 600))).toBeNull();
    expect(lthrEstimate({ list: [], activities: {} })).toBeNull();
  });
});

describe("checkLthr", () => {
  it("flags LTHR from 98% of the 20-minute best (the issue's acceptance case, on intervals.icu's rule)", () => {
    const check = checkLthr(172, read(), 190);
    expect(check.status).toBe("above");
    expect(check.setting_bpm).toBe(172);
    expect(check.estimate_bpm).toBe(174);
    expect(check.basis).toMatchObject({
      duration_s: 1200,
      activity_id: "i300000002",
    });
    expect(check.message).toContain(
      "LTHR estimate 174 bpm: 98% of your best 20-minute heart rate in the last 90 days (178 bpm, 2026-08-30, i300000002). This is above your LTHR of 172 bpm.",
    );
    expect(check.message).toMatch(
      /Your LTHR may be out of date.*sensor errors\.$/s,
    );
  });

  it("flags LTHR from the 60-minute best", () => {
    // 98% of 175 is 171.5, so 172; the 60-minute best of 173 is higher.
    const curvesHour = withValue("90d", 3600, 173, withValue("90d", 1200, 175));
    const check = checkLthr(172, read(curvesHour), 190);
    expect(check.status).toBe("above");
    expect(check.estimate_bpm).toBe(173);
    expect(check.message).toContain(
      "LTHR estimate 173 bpm: your best 60-minute heart rate in the last 90 days (173 bpm, 2026-09-21, i300000003). This is above your LTHR of 172 bpm.",
    );
  });

  it("does not flag an estimate equal to LTHR", () => {
    // 98% of 176 is 172.48, so 172.
    const check = checkLthr(172, read(withValue("90d", 1200, 176)), 190);
    expect(check.status).toBe("not_above");
    expect(check.estimate_bpm).toBe(172);
    expect(check.message).toBe(
      "No heart rate best in the last 90 days points above your LTHR of 172 bpm: 98% of your best 20-minute heart rate (176 bpm, 2026-08-30, i300000002) is 172 bpm.",
    );
  });

  it("does not flag an estimate below LTHR", () => {
    const low = withValue("90d", 3600, 165, withValue("90d", 1200, 170));
    const check = checkLthr(172, read(low), 190);
    expect(check.status).toBe("not_above");
    expect(check.estimate_bpm).toBe(167);
  });

  it("does not flag a 30-minute best above LTHR on its own", () => {
    // The 30-minute best (175) is above 172, but intervals.icu's rule gives 172.
    const check = checkLthr(172, read(withValue("90d", 1200, 176)), 190);
    expect(hrBests(withValue("90d", 1200, 176))[1]?.bpm).toBe(175);
    expect(check.status).toBe("not_above");
  });

  it("says when no LTHR is set, with the estimate", () => {
    const check = checkLthr(null, read(), 190);
    expect(check.status).toBe("unknown");
    expect(check.estimate_bpm).toBe(174);
    expect(check.message).toBe(
      "No LTHR is set for this sport. By intervals.icu's rule, your heart rate bests in the last 90 days put LTHR at 174 bpm or higher: 98% of your best 20-minute heart rate (178 bpm, 2026-08-30, i300000002) is 174 bpm.",
    );
  });

  it("does not call a dropout-shaped best an estimate", () => {
    // 20-minute best 50 bpm (sensor dropouts averaged in), max HR 190.
    const dropout = withValue("90d", 3600, 48, withValue("90d", 1200, 50));
    const set = checkLthr(172, read(dropout), 190);
    expect(set.status).toBe("unknown");
    expect(set.estimate_bpm).toBeNull();
    expect(set.message).toContain("Not checked:");
    expect(set.message).toContain("sensor dropouts");
    expect(set.message).not.toContain("estimate");
    const unset = checkLthr(null, read(dropout), 190);
    expect(unset.estimate_bpm).toBeNull();
    expect(unset.message).toContain("The heart rate bests were not used");
  });

  it("is unknown for the Other group, a failed read, or no points", () => {
    expect(checkLthr(172, { status: "skipped_other_group" }, 190).message).toBe(
      "Not checked: intervals.icu has no heart rate curve for the Other group.",
    );
    const failed = checkLthr(172, { status: "failed", reason: "x" }, 190);
    expect(failed.status).toBe("unknown");
    expect(failed.message).toBe(
      "Not checked: the heart rate curves could not be read.",
    );
    const none = checkLthr(172, read(cutAt("90d", 600)), 190);
    expect(none.status).toBe("unknown");
    expect(none.message).toBe(
      "Not checked: no 20-minute or 60-minute heart rate best in the last 90 days.",
    );
  });
});

describe("checkMaxHr", () => {
  it("uses the 60-second best, not a 1-second spike", () => {
    // The fixture's 1-year curve has 193 at 1 s, above max HR 190.
    const check = checkMaxHr(190, read());
    expect(check.status).toBe("not_above");
    expect(check.estimate_bpm).toBe(188);
    expect(check.message).toBe(
      "Your best 60-second heart rate in the last year is 188 bpm (2026-03-08, i300000004). This is not above your max HR of 190 bpm.",
    );
  });

  it("flags a 60-second best above max HR", () => {
    const check = checkMaxHr(190, read(withValue("1y", 60, 191)));
    expect(check.status).toBe("above");
    expect(check.message).toContain("above your max HR of 190 bpm");
    expect(check.message).toContain("may be set too low");
  });

  it("does not flag a 60-second best equal to max HR", () => {
    expect(checkMaxHr(190, read(withValue("1y", 60, 190))).status).toBe(
      "not_above",
    );
  });

  it("says when no max HR is set, with the best", () => {
    expect(checkMaxHr(null, read()).message).toBe(
      "No max HR is set for this sport. Your best 60-second heart rate in the last year is 188 bpm (2026-03-08, i300000004).",
    );
  });

  it("is unknown with no 1-year curve", () => {
    const only90 = {
      ...curves,
      list: curves.list.filter((c) => c.id === "90d"),
    };
    expect(checkMaxHr(190, read(only90)).message).toBe(
      "Not checked: no 60-second heart rate best in the last year.",
    );
  });
});

describe("buildAthleteZones", () => {
  it("builds the Run payload from the fixtures", () => {
    const resolved = resolveSportGroup(groups, "Run")!;
    const response = buildAthleteZones(groups, resolved, read());
    expect(response).toMatchObject({
      sport: "Run",
      settings_types: ["Run", "VirtualRun", "TrailRun"],
      default_group: false,
      lthr_bpm: 172,
      max_hr_bpm: 190,
      threshold_speed_mps: 3.571,
      threshold_pace_min_per_km: "4:40",
      pace_units: "MINS_KM",
      ftp_watts: null,
      warnings: [],
    });
    expect(response.hr_bests).toHaveLength(4);
    expect(response.threshold_checks.lthr.status).toBe("above");
    expect(response.threshold_checks.max_hr.status).toBe("not_above");
    expect(response.other_groups).toHaveLength(3);
    expect(response.other_groups).toContainEqual(["Other"]);
    expect(AthleteZonesOutputSchema.parse(response)).toEqual(response);
  });

  it("names the default Other group for a sport no group lists", () => {
    const resolved = resolveSportGroup(groups, "Rowing")!;
    const response = buildAthleteZones(groups, resolved, {
      status: "skipped_other_group",
    });
    expect(response.default_group).toBe(true);
    expect(response.warnings[0]).toBe(
      "No settings group lists Rowing, so these are intervals.icu's default Other settings.",
    );
    expect(response.other_groups).toHaveLength(3);
    expect(response.other_groups).not.toContainEqual(["Other"]);
    expect(response.hr_bests).toEqual([]);
    expect(AthleteZonesOutputSchema.parse(response)).toEqual(response);
  });

  it("keeps the zones and warns when the curve read failed", () => {
    const resolved = resolveSportGroup(groups, "Swim")!;
    const response = buildAthleteZones(groups, resolved, {
      status: "failed",
      reason: "the intervals.icu rate limit was reached",
    });
    expect(response.hr_zones).toHaveLength(7);
    expect(response.threshold_pace_min_per_100m).toBe("2:05");
    expect(response.warnings).toEqual([
      "Heart rate curves not read: the intervals.icu rate limit was reached. LTHR and max HR were not checked.",
    ]);
    expect(response.threshold_checks.lthr.status).toBe("unknown");
    expect(response.threshold_checks.max_hr.status).toBe("unknown");
    expect(AthleteZonesOutputSchema.parse(response)).toEqual(response);
  });

  it("reports FTP from the ride group", () => {
    const resolved = resolveSportGroup(groups, "Ride")!;
    expect(buildAthleteZones(groups, resolved, read()).ftp_watts).toBe(200);
  });
});
