/**
 * One structured payload per tool group (#243), driven through
 * `dispatchToolCall` — the path a host actually takes — and validated against
 * the schema each tool advertises. Before this, these tools rendered ids into
 * prose like `(ID: 123)` and a caller had to regex them back out to chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActivity } from "../intervalsClient";
import { getAuthenticatedAthlete, updateActivity } from "../stravaClient";
import {
  ActivityLapsOutputSchema,
  ActivityWriteOutputSchema,
  ActivityZonesOutputSchema,
} from "./outputs";

vi.mock("../stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stravaClient")>();
  return {
    ...actual,
    getAuthenticatedAthlete: vi.fn(),
    updateActivity: vi.fn(),
  };
});

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return { ...actual, getActivity: vi.fn() };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { dispatchToolCall } = await import("../server");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedAthlete).mockResolvedValue({
    measurement_preference: "meters",
  } as never);
});

describe("activity read tools", () => {
  it("get-activity-zones publishes the same buckets the chart draws", async () => {
    vi.mocked(getActivity).mockResolvedValueOnce({
      id: "i1122334455",
      name: "Zone Test Run",
      type: "Run",
      start_date_local: "2026-09-21T09:00:00",
      icu_hr_zones: [120, 190],
      icu_hr_zone_times: [600, 400],
    } as never);

    const result = await dispatchToolCall("get-activity-zones", {
      id: "i1122334455",
    });

    const structured = ActivityZonesOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.zone_sets).toHaveLength(1);
    const set = structured.zone_sets[0]!;
    expect(set.type).toBe("heartrate");
    expect(set.total_seconds).toBe(1000);
    // The activity's own recorded top-zone bound is real, not an
    // open-ended sentinel, as in the app mapper.
    expect(set.buckets[1]!.max).toBe(190);
    expect(set.buckets[0]!.pct).toBe(60);
  });

  it("get-activity-laps still answers with data when nothing was lapped", async () => {
    // A successful call from a tool that advertises an outputSchema must carry
    // structuredContent — the SDK client raises InvalidRequest otherwise, so a
    // text-only "no laps recorded" reached the host as a protocol error.
    vi.mocked(getActivity).mockResolvedValueOnce({
      id: "i777",
      name: "Rest Day Walk",
      type: "Walk",
      start_date_local: "2026-09-21T09:00:00",
      icu_intervals: [],
    } as never);

    const result = await dispatchToolCall("get-activity-laps", {
      id: "i777",
    });

    expect(result.isError).toBeUndefined();
    expect(ActivityLapsOutputSchema.parse(result.structuredContent)).toEqual({
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
});

describe("activity write tools", () => {
  const written = {
    id: "9001",
    name: "Morning Yoga",
    sport_type: "Yoga",
    start_date_local: "2026-07-13T07:30:00Z",
    distance: 0,
    elapsed_time: 1800,
    description: null,
    gear_id: null,
    commute: false,
    trainer: false,
  };

  it("update-activity returns the activity as Strava echoed it back", async () => {
    vi.mocked(updateActivity).mockResolvedValueOnce({
      ...written,
      name: "Renamed",
      description: "Felt strong",
    } as never);

    const result = await dispatchToolCall("update-activity", {
      activityId: "9001",
      name: "Renamed",
    });

    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.name).toBe("Renamed");
    expect(structured.description).toBe("Felt strong");
  });
});
