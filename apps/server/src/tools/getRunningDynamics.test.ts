import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import activityIntervalsFixture from "../__fixtures__/intervals/activity-intervals.json";
import multilapActivityFixture from "../__fixtures__/intervals/activity-multilap.json";
import multilapIntervalsFixture from "../__fixtures__/intervals/activity-multilap-intervals.json";
import {
  getActivity,
  type IntervalsActivity,
  type IntervalsInterval,
} from "../intervalsClient";
import {
  formatRunningDynamicsText,
  getRunningDynamicsTool,
  mapRunningDynamics,
  type RunningDynamicsResponse,
} from "./getRunningDynamics";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);

const runActivity = activityFixture as unknown as IntervalsActivity;

/** The run fixture with its intervals merged in, as `getActivity(..., {intervals: true})` returns it. */
const runActivityWithIntervals: IntervalsActivity = {
  ...runActivity,
  icu_intervals:
    activityIntervalsFixture.icu_intervals as unknown as IntervalsInterval[],
};

const multilapActivityWithIntervals: IntervalsActivity = {
  ...(multilapActivityFixture as unknown as IntervalsActivity),
  icu_intervals:
    multilapIntervalsFixture.icu_intervals as unknown as IntervalsInterval[],
};

describe("mapRunningDynamics", () => {
  it("maps the base run fixture's averages and VO/GCT assessments", () => {
    const d = mapRunningDynamics(runActivityWithIntervals, true);

    expect(d.has_dynamics).toBe(true);
    expect(d.message).toBeNull();
    expect(d.averages).toEqual({
      // average_vertical_oscillation 108.36414 rounds to 108 mm.
      stance_time_ms: 233,
      vertical_oscillation_mm: 108,
      vertical_ratio_pct: 8.8,
      step_length_mm: 1226,
      stride_m: 1.22,
      cadence_spm: 166,
    });
    expect(d.assessments).toEqual({
      vertical_oscillation: {
        value: 108,
        target: "under 100 mm",
        status: "high",
        message: "high - at or above the 100 mm target",
      },
      ground_contact_time: {
        value: 233,
        target: "200-260 ms",
        status: "within",
        message: "good - within the 200-260 ms target range",
      },
    });
  });

  it("returns one row per WORK interval, skipping RECOVERY", () => {
    const d = mapRunningDynamics(runActivityWithIntervals, true);

    expect(d.intervals).toHaveLength(1);
    expect(d.intervals[0]).toMatchObject({
      lap_index: 1,
      // distance 7010.97 m over 2075 s.
      pace_sec_per_km: 296,
      stance_time_ms: 234,
      stance_time_status: "within",
      vertical_oscillation_mm: 108,
      vertical_oscillation_status: "high",
      // average_stride 1.219285 rounds to 1.22 m.
      stride_m: 1.22,
    });
  });

  it("omits interval rows when includeIntervals is false", () => {
    const d = mapRunningDynamics(runActivityWithIntervals, false);
    expect(d.intervals).toEqual([]);
  });

  it("maps every WORK interval across a multi-lap activity", () => {
    const d = mapRunningDynamics(multilapActivityWithIntervals, true);
    expect(d.intervals).toHaveLength(12);
    expect(d.intervals.map((r) => r.lap_index)).toEqual([
      1, 3, 5, 6, 7, 8, 9, 10, 12, 13, 15, 17,
    ]);
  });

  it("reports has_dynamics: false with a message for a non-step-cadence type", () => {
    const ride: IntervalsActivity = {
      id: "i555",
      name: "Crit Practice",
      type: "Ride",
      start_date_local: "2026-09-20T09:00:00",
      icu_intervals: [],
    } as unknown as IntervalsActivity;

    const d = mapRunningDynamics(ride, true);
    expect(d.has_dynamics).toBe(false);
    expect(d.averages).toBeNull();
    expect(d.assessments).toBeNull();
    expect(d.intervals).toEqual([]);
    expect(d.message).toMatch(/not a step-cadence activity type/);
  });

  it("reports has_dynamics: false with a message when the device recorded no dynamics", () => {
    const noDynamics: IntervalsActivity = {
      ...runActivityWithIntervals,
      average_stance_time: null,
    };

    const d = mapRunningDynamics(noDynamics, true);
    expect(d.has_dynamics).toBe(false);
    expect(d.averages).toBeNull();
    expect(d.assessments).toBeNull();
    expect(d.intervals).toEqual([]);
    expect(d.message).toMatch(/no running dynamics recorded/);
  });
});

describe("formatRunningDynamicsText", () => {
  it("renders averages, assessment, and interval lines for the base run", () => {
    const d = mapRunningDynamics(runActivityWithIntervals, true);
    const text = formatRunningDynamicsText(d);

    expect(text).toContain("Run running dynamics");
    expect(text).toContain("GCT 233 ms");
    expect(text).toContain("VO 108 mm");
    expect(text).toContain(
      "Assessment: VO high - at or above the 100 mm target; GCT good - within the 200-260 ms target range",
    );
    expect(text).toContain("WORK intervals:");
    expect(text).toContain("1.");
  });

  it("prints step length but not stride, which is the same per-step distance", () => {
    const d = mapRunningDynamics(runActivityWithIntervals, true);
    const lines = formatRunningDynamicsText(d).split("\n");

    expect(lines.find((l) => l.startsWith("Averages:"))).toBe(
      "Averages: GCT 233 ms, VO 108 mm, vertical ratio 8.8%, step length 1226 mm, cadence 166 spm",
    );
    expect(lines.find((l) => l.startsWith("1. "))).toMatch(
      /, step 1224 mm, cadence 166 spm$/,
    );
    expect(lines.join("\n")).not.toContain("stride");
    // structuredContent keeps stride_m on the averages and on each row.
    expect(d.averages?.stride_m).toBe(1.22);
    expect(d.intervals[0]?.stride_m).toBe(1.22);
  });

  it("renders the no-dynamics message without a stack trace of empty sections", () => {
    const d = mapRunningDynamics(
      { ...runActivityWithIntervals, average_stance_time: null },
      true,
    );
    const text = formatRunningDynamicsText(d);

    expect(text).toContain("no running dynamics recorded");
    expect(text).not.toContain("Averages:");
    expect(text).not.toContain("WORK intervals:");
  });

  it("caps the interval list at 20 lines with a '(n more)' note", () => {
    const row = {
      lap_index: 1,
      label: null,
      distance_km: 1,
      pace_sec_per_km: 300,
      pace_min_per_km: "5:00",
      stance_time_ms: 233,
      stance_time_status: "within" as const,
      vertical_oscillation_mm: 90,
      vertical_oscillation_status: "within" as const,
      vertical_ratio_pct: 8,
      step_length_mm: 1200,
      stride_m: 1.2,
      cadence_spm: 170,
    };
    const d: RunningDynamicsResponse = {
      activity_id: "i1",
      activity_name: "Long fartlek",
      type: "Run",
      has_dynamics: true,
      message: null,
      averages: {
        stance_time_ms: 233,
        vertical_oscillation_mm: 90,
        vertical_ratio_pct: 8,
        step_length_mm: 1200,
        stride_m: 1.2,
        cadence_spm: 170,
      },
      assessments: {
        vertical_oscillation: {
          value: 90,
          target: "under 100 mm",
          status: "within",
          message: "good - under the 100 mm target",
        },
        ground_contact_time: {
          value: 233,
          target: "200-260 ms",
          status: "within",
          message: "good - within the 200-260 ms target range",
        },
      },
      intervals: Array.from({ length: 25 }, (_, i) => ({
        ...row,
        lap_index: i + 1,
      })),
      units: {
        stance_time: "ms",
        vertical_oscillation: "mm",
        vertical_ratio: "%",
        step_length: "mm",
        stride: "m",
        cadence: "spm",
        pace: "min/km",
      },
    };

    const text = formatRunningDynamicsText(d);
    const lines = text.split("\n");
    expect(lines.filter((l) => /^\d+\.\s/.test(l))).toHaveLength(20);
    expect(text).toContain("(5 more)");
  });
});

describe("getRunningDynamicsTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
  });

  it("fetches with intervals: true and returns structured content", async () => {
    mockedGetActivity.mockResolvedValue(runActivityWithIntervals);

    const result = await getRunningDynamicsTool.execute(
      { id: "i189807578", includeIntervals: true },
      "test-key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("test-key", "i189807578", {
      intervals: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.has_dynamics).toBe(true);
    expect(result.structuredContent?.intervals).toHaveLength(1);
  });

  it("returns toolErrorText with notFound on a 404", async () => {
    mockedGetActivity.mockRejectedValue(
      handledNotFound("getActivity for ID i404"),
    );

    const result = await getRunningDynamicsTool.execute(
      { id: "i404", includeIntervals: true },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
    expect(result.content[0]?.text).toContain("i404");
  });

  it("returns toolErrorText on a rate limit error", async () => {
    mockedGetActivity.mockRejectedValue(
      handledRateLimit("getActivity for ID i1"),
    );

    const result = await getRunningDynamicsTool.execute(
      { id: "i1", includeIntervals: true },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
  });
});
