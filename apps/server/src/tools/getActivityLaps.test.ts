import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityMultilap from "../__fixtures__/intervals/activity-multilap.json";
import multilapIntervals from "../__fixtures__/intervals/activity-multilap-intervals.json";
import {
  getActivity,
  type IntervalsActivity,
  type IntervalsInterval,
} from "../intervalsClient";
import { formatActivityLapsText, getActivityLapsTool } from "./getActivityLaps";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);

const runActivityWithIntervals: IntervalsActivity = {
  ...(activityMultilap as unknown as IntervalsActivity),
  icu_intervals:
    multilapIntervals.icu_intervals as unknown as IntervalsInterval[],
};

const rideActivity: IntervalsActivity = {
  id: "i555",
  name: "Crit Practice",
  type: "Ride",
  start_date_local: "2026-09-20T09:00:00",
  icu_lap_count: 1,
  icu_intervals_edited: false,
  icu_intervals: [
    {
      type: "WORK",
      label: null,
      distance: 5000,
      moving_time: 500,
      elapsed_time: 500,
      average_heartrate: 150,
      max_heartrate: 165,
      average_cadence: 88,
      average_speed: 10,
      gap: 9.5,
      total_elevation_gain: 20,
      average_watts: 214.6,
      average_gradient: 0.01,
    } as unknown as IntervalsInterval,
  ],
} as unknown as IntervalsActivity;

describe("getActivityLapsTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
  });

  it("renders run laps with pace, GAP, and doubled cadence, in order", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivityWithIntervals);

    const result = await getActivityLapsTool.execute(
      { id: "i189757183" },
      "test-key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("test-key", "i189757183", {
      intervals: true,
    });

    const structured = result.structuredContent as unknown as Record<
      string,
      unknown
    >;
    expect(structured.sport_type).toBe("Run");
    expect(structured.lap_source).toBe("intervals.icu intervals");
    expect(structured.device_lap_count).toBe(12);
    expect(structured.intervals_edited).toBe(true);
    const laps = structured.laps as Array<Record<string, unknown>>;
    expect(structured.lap_count).toBe(laps.length);
    expect(laps.length).toBe(
      (multilapIntervals.icu_intervals as unknown[]).length,
    );
    expect(laps.map((lap) => lap.lap_index)).toEqual(laps.map((_, i) => i + 1));
    expect(laps[0]?.pace_min_per_km).toBe("5:12");
    expect(laps[0]?.gap_min_per_km).toBe("4:52");
    expect(laps[0]?.average_cadence).toBe(161);

    const text = result.content[0]?.text ?? "";
    expect(text).toContain('Run laps for "Run 1"');
    expect(text).toContain("5:12 /km");
    expect(text).toContain("GAP 4:52 /km");
    expect(text).toContain("161 spm");
    // 12 device laps but 18 icu_intervals, plus icu_intervals_edited true.
    expect(text).toContain("intervals were edited in intervals.icu");
    expect(text).toContain("device recorded 12 laps, not 18");
  });

  it("renders speed and rpm cadence for a non-pace sport (Ride)", async () => {
    mockedGetActivity.mockResolvedValueOnce(rideActivity);

    const result = await getActivityLapsTool.execute(
      { id: "i555" },
      "test-key",
    );

    const structured = result.structuredContent as unknown as Record<
      string,
      unknown
    >;
    const laps = structured.laps as Array<Record<string, unknown>>;
    expect(structured.units).toMatchObject({ cadence: "rpm" });
    expect(laps[0]?.pace_min_per_km).toBeNull();
    expect(laps[0]?.speed_kmh).toBe(36);
    expect(laps[0]?.average_cadence).toBe(88);
    expect(laps[0]?.average_watts).toBe(214.6);

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("36 km/h");
    expect(text).toContain("88 rpm");
    expect(text).not.toContain("/km");
    // Device lap count matches, and nothing was edited: no flag line.
    expect(text).not.toContain("Note:");
  });

  it("returns a valid empty payload when the activity has no intervals", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      id: "i777",
      name: "Rest Day Walk",
      type: "Walk",
      start_date_local: "2026-09-21T09:00:00",
      icu_lap_count: null,
      icu_intervals_edited: null,
      icu_intervals: [],
    } as unknown as IntervalsActivity);

    const result = await getActivityLapsTool.execute(
      { id: "i777" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      "No intervals recorded for this activity.",
    );
    expect(result.structuredContent).toEqual({
      activity_id: "i777",
      activity_name: "Rest Day Walk",
      sport_type: "Walk",
      lap_count: 0,
      lap_source: "intervals.icu intervals",
      device_lap_count: null,
      intervals_edited: null,
      units: {
        distance: "km",
        pace: "min/km",
        speed: "km/h",
        time: "s",
        hr: "bpm",
        elevation: "m",
        cadence: "spm",
        gradient: "%",
      },
      laps: [],
    });
  });

  it("returns a valid empty payload when icu_intervals is absent (intervals not requested)", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      id: "i888",
      name: "No Intervals",
      type: "Run",
      start_date_local: "2026-09-22T09:00:00",
    } as unknown as IntervalsActivity);

    const result = await getActivityLapsTool.execute(
      { id: "i888" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ lap_count: 0, laps: [] });
  });

  it("returns a friendly error for a missing activity", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledNotFound("getActivity for ID i404404"),
    );

    const result = await getActivityLapsTool.execute(
      { id: "i404404" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("❌ Activity i404404 was not found.");
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledRateLimit("getActivity for ID i123"),
    );

    const result = await getActivityLapsTool.execute(
      { id: "i123" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("❌")).toBe(true);
    expect(text).toContain("rate limit");
    expect(text).toContain("15-minute rate limit reached (100/100 requests).");
  });

  it("reports other failures with details", async () => {
    mockedGetActivity.mockRejectedValueOnce(new Error("Bad Gateway"));

    const result = await getActivityLapsTool.execute(
      { id: "i123" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "❌ Failed to fetch laps for activity i123: Bad Gateway",
    );
  });
});

describe("formatActivityLapsText", () => {
  it("flags an edited count without a lap list when there are no laps", () => {
    const text = formatActivityLapsText({
      activity_id: "i1",
      activity_name: "Empty",
      sport_type: "Run",
      lap_count: 0,
      lap_source: "intervals.icu intervals",
      device_lap_count: 3,
      intervals_edited: null,
      units: {
        distance: "km",
        pace: "min/km",
        speed: "km/h",
        time: "s",
        hr: "bpm",
        elevation: "m",
        cadence: "spm",
        gradient: "%",
      },
      laps: [],
    });

    expect(text).toBe(
      'Run laps for "Empty" [i1]\nNo intervals recorded for this activity.',
    );
  });
});
