import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import activityIntervalsFixture from "../__fixtures__/intervals/activity-intervals.json";
import activityMultilap from "../__fixtures__/intervals/activity-multilap.json";
import multilapIntervals from "../__fixtures__/intervals/activity-multilap-intervals.json";
import sportSettingsRunFixture from "../__fixtures__/intervals/sport-settings-run.json";
import {
  getActivity,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsInterval,
  type IntervalsSportSettings,
} from "../intervalsClient";
import {
  formatRunningSummaryText,
  getRunningSummaryTool,
  mapRunningSummary,
} from "./getRunningSummary";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn(), getSportSettings: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetSportSettings = vi.mocked(getSportSettings);

const runActivity = activityFixture as unknown as IntervalsActivity;
const sportSettingsRun =
  sportSettingsRunFixture as unknown as IntervalsSportSettings;

/** The run fixture with its intervals merged in, as `getActivity(..., {intervals: true})` returns it. */
const runActivityWithIntervals: IntervalsActivity = {
  ...runActivity,
  icu_intervals: activityIntervalsFixture.icu_intervals,
};

const multilapActivityWithIntervals: IntervalsActivity = {
  ...(activityMultilap as unknown as IntervalsActivity),
  icu_intervals:
    multilapIntervals.icu_intervals as unknown as IntervalsInterval[],
};

const rideActivity: IntervalsActivity = {
  id: "i555",
  name: "Crit Practice",
  type: "Ride",
  start_date_local: "2026-09-20T09:00:00",
  icu_intervals: [],
} as unknown as IntervalsActivity;

describe("mapRunningSummary", () => {
  it("maps the base run fixture: get-activity fields plus assessments and laps", () => {
    const summary = mapRunningSummary(
      runActivityWithIntervals,
      sportSettingsRun,
    );

    // get-activity's own fields carry through unchanged.
    expect(summary.id).toBe("i189807578");
    expect(summary.type).toBe("Run");
    expect(summary.pace_min_per_km).toBe("4:55");
    expect(summary.average_cadence_spm).toBe(166);
    expect(summary.hr_zones).toHaveLength(5);

    // Run-specific additions. 166 spm sits in the 160-169 "moderate" band.
    expect(summary.cadence_assessment).toBe("moderate - room for improvement");
    expect(summary.dynamics_assessment).toEqual({
      // average_vertical_oscillation 108.36414 -> 108mm, at/above the 100mm target.
      vertical_oscillation: "high - above the 100 mm target",
      // average_stance_time 233.21266 -> 233ms, within 200-260ms.
      ground_contact_time: "good - within the 200-260 ms target range",
    });
    expect(summary.hr_zone_summary).toEqual({
      source: "activity",
      total_seconds: 2374,
      zones: [
        { zone: 1, min_bpm: 0, max_bpm: 147, seconds: 103, percent: 4.3 },
        { zone: 2, min_bpm: 147, max_bpm: 160, seconds: 146, percent: 6.1 },
        { zone: 3, min_bpm: 160, max_bpm: 169, seconds: 330, percent: 13.9 },
        { zone: 4, min_bpm: 169, max_bpm: 178, seconds: 1684, percent: 70.9 },
        { zone: 5, min_bpm: 178, max_bpm: 197, seconds: 111, percent: 4.7 },
      ],
    });
    expect(summary.hr_zone_note).toBeNull();
    expect(summary.laps).toHaveLength(2);
    expect(summary.laps[0]?.lap_index).toBe(1);

    // No power block anywhere in the output.
    expect(summary).not.toHaveProperty("power");
    // `intervals` is dropped: `laps` carries the same icu_intervals
    // breakdown, and shipping both would duplicate it.
    expect(summary).not.toHaveProperty("intervals");
  });

  it("falls back to sport settings bounds when the activity has no icu_hr_zones", () => {
    const activity: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: null,
    };

    const summary = mapRunningSummary(activity, sportSettingsRun);

    expect(summary.hr_zone_summary?.source).toBe("sport_settings");
    expect(summary.hr_zone_summary?.zones.map((z) => z.max_bpm)).toEqual([
      147, 160, 169, 178, 197,
    ]);
  });

  it("omits the zone summary with a note when bounds and zone-time counts differ", () => {
    const activity: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: [150, 165, 180, 197],
    };

    const summary = mapRunningSummary(activity, sportSettingsRun);

    expect(summary.hr_zone_summary).toBeNull();
    expect(summary.hr_zone_note).toContain("do not match");
  });

  it("omits the zone summary with a note when no bounds are available at all", () => {
    const activity: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: null,
    };

    const summary = mapRunningSummary(activity, null);

    expect(summary.hr_zone_summary).toBeNull();
    expect(summary.hr_zone_note).toBe(
      "HR zone bounds are unavailable; recorded zone times could not be labelled.",
    );
  });

  it("maps the multi-lap fixture with all 18 intervals as laps", () => {
    const summary = mapRunningSummary(
      multilapActivityWithIntervals,
      sportSettingsRun,
    );

    expect(summary.laps).toHaveLength(18);
    expect(summary.cadence_assessment).toBe("moderate - room for improvement");
    expect(summary.dynamics_assessment).toEqual({
      vertical_oscillation: "high - above the 100 mm target",
      ground_contact_time: "good - within the 200-260 ms target range",
    });
    expect(summary.hr_zone_summary?.zones.map((z) => z.percent)).toEqual([
      4.4, 6.5, 11.2, 43.4, 34.4,
    ]);
  });

  it("leaves dynamics_assessment null when the activity has no running dynamics", () => {
    const activity: IntervalsActivity = {
      ...runActivityWithIntervals,
      average_stance_time: null,
    };

    const summary = mapRunningSummary(activity, sportSettingsRun);

    expect(summary.running_dynamics).toBeNull();
    expect(summary.dynamics_assessment).toBeNull();
  });
});

describe("formatRunningSummaryText", () => {
  it("includes the assessment and HR zone lines, and caps laps at 20 with a remainder note", () => {
    const summary = mapRunningSummary(
      multilapActivityWithIntervals,
      sportSettingsRun,
    );
    // Pad laps past the 20-line cap without needing a bigger fixture.
    const padded = {
      ...summary,
      laps: [...summary.laps, ...summary.laps],
    };

    const text = formatRunningSummaryText(padded);

    expect(text).toContain("Cadence assessment: moderate");
    expect(text).toContain("Dynamics assessment: VO high");
    expect(text).toContain("HR zones: Z1 0-147");
    expect(text).toContain("Laps:");
    expect(text).toContain("(16 more)");
    expect(text).not.toContain("🏃");
    expect(text).not.toContain("Strava");
  });

  it("renders an open-ended top zone bound as N+ rather than N-null", () => {
    const summary = mapRunningSummary(
      multilapActivityWithIntervals,
      sportSettingsRun,
    );
    const withOpenTopZone = {
      ...summary,
      hr_zone_summary: summary.hr_zone_summary && {
        ...summary.hr_zone_summary,
        zones: summary.hr_zone_summary.zones.map((z, i, zones) =>
          i === zones.length - 1 ? { ...z, max_bpm: null } : z,
        ),
      },
    };

    const text = formatRunningSummaryText(withOpenTopZone);

    expect(text).toMatch(/Z5 \d+\+/);
    expect(text).not.toContain("null");
  });
});

describe("getRunningSummaryTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
    mockedGetSportSettings.mockReset();
  });

  it("fetches the activity with intervals and Run sport settings, returning structured content", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivityWithIntervals);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getRunningSummaryTool.execute(
      { id: "i189807578" },
      "key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("key", "i189807578", {
      intervals: true,
    });
    expect(mockedGetSportSettings).toHaveBeenCalledWith("key", "Run");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe("i189807578");
    expect(result.structuredContent?.laps).toHaveLength(2);
    expect(result.structuredContent?.cadence_assessment).toBe(
      "moderate - room for improvement",
    );
  });

  it("rejects a non-run activity, naming the type and pointing to get-activity", async () => {
    mockedGetActivity.mockResolvedValueOnce(rideActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getRunningSummaryTool.execute({ id: "i555" }, "key");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Ride");
    expect(result.content[0]?.text).toContain("get-activity");
  });

  it("degrades to a null hr_zone_summary when sport settings fail, without failing the call", async () => {
    const activity: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: null,
    };
    mockedGetActivity.mockResolvedValueOnce(activity);
    mockedGetSportSettings.mockRejectedValueOnce(
      handledNotFound("getSportSettings"),
    );

    const result = await getRunningSummaryTool.execute(
      { id: "i189807578" },
      "key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.hr_zone_summary).toBeNull();
  });

  it("fails with the notFound text on a genuine 404", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledNotFound("getActivity for ID i0"),
    );
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getRunningSummaryTool.execute({ id: "i0" }, "key");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
    expect(result.content[0]?.text).toContain("i0 was not found");
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledRateLimit("getActivity for ID i189807578"),
    );
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getRunningSummaryTool.execute(
      { id: "i189807578" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Rate limit");
  });
});
