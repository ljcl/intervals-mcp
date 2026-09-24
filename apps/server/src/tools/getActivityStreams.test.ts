import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import streamsFixture from "../__fixtures__/intervals/streams.json";
import {
  getActivity,
  getActivityStreams,
  type IntervalsActivity,
  type IntervalsStream,
} from "../intervalsClient";
import {
  buildActivityStreamsResult,
  formatActivityStreamsText,
  getActivityStreamsTool,
  type StreamType,
} from "./getActivityStreams";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn(), getActivityStreams: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetActivityStreams = vi.mocked(getActivityStreams);

const runActivity = activityFixture as unknown as IntervalsActivity;
const streams = streamsFixture as unknown as IntervalsStream[];

const ALL_TYPES: StreamType[] = [
  "time",
  "distance",
  "heartrate",
  "cadence",
  "velocity_smooth",
  "altitude",
  "latlng",
  "watts",
  "stance_time",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
];

describe("buildActivityStreamsResult", () => {
  it("downsamples the 600-point fixture to 100 points per column", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ALL_TYPES,
      100,
    );

    expect(result.activity_id).toBe("i189807578");
    expect(result.type).toBe("Run");
    expect(result.original_points).toBe(600);
    expect(result.returned_points).toBe(100);
    expect(result.requested).toEqual(ALL_TYPES);
    // The fixture activity's stream_types lists "watts", but its actual
    // streams response has no watts entry, which is the case the fixture
    // was built to exercise.
    expect(result.missing).toEqual(["watts"]);
    expect(Object.keys(result.streams).sort()).toEqual(
      [
        "altitude",
        "cadence",
        "distance",
        "heartrate",
        "latlng",
        "stance_time",
        "step_length",
        "time",
        "velocity_smooth",
        "vertical_oscillation",
        "vertical_ratio",
      ].sort(),
    );
    // watts is absent from units: it's requested but missing, not returned.
    expect(result.units).toEqual({
      time: "s",
      distance: "m",
      heartrate: "bpm",
      cadence: "spm",
      velocity_smooth: "m/s",
      altitude: "m",
      latlng: "deg",
      stance_time: "ms",
      vertical_oscillation: "mm",
      vertical_ratio: "%",
      step_length: "mm",
    });
  });

  it("takes time/distance as the bucket's last raw sample, rounded", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ALL_TYPES,
      100,
    );

    expect(result.streams.time?.[0]).toBe(5);
    expect(result.streams.time?.[99]).toBe(599);
    expect(result.streams.distance?.[0]).toBe(8.4);
    expect(result.streams.distance?.[99]).toBe(1998.1);
  });

  it("means non-null samples per bucket for heartrate/altitude/velocity_smooth", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ALL_TYPES,
      100,
    );

    expect(result.streams.heartrate?.[0]).toBe(104);
    expect(result.streams.heartrate?.[99]).toBe(170);
    expect(result.streams.altitude?.[0]).toBe(8.4);
    expect(result.streams.velocity_smooth?.[0]).toBe(3.69);
  });

  it("means running-dynamics streams with their documented decimal places", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ALL_TYPES,
      100,
    );

    expect(result.streams.stance_time?.[99]).toBe(232.5);
    expect(result.streams.vertical_oscillation?.[99]).toBe(109.4);
    expect(result.streams.vertical_ratio?.[99]).toBe(9.15);
    expect(result.streams.step_length?.[99]).toBe(1195);
  });

  it("doubles cadence to steps/min for a run activity type", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ALL_TYPES,
      100,
    );

    expect(result.streams.cadence?.[0]).toBe(126);
    expect(result.streams.cadence?.[99]).toBe(169);
  });

  it("does not double cadence for a non-run activity type", () => {
    const rideActivity: IntervalsActivity = { ...runActivity, type: "Ride" };
    const result = buildActivityStreamsResult(
      rideActivity,
      streams,
      ["cadence"],
      100,
    );

    // Same bucket, raw (un-doubled) mean of 63.
    expect(result.streams.cadence?.[0]).toBe(63);
    expect(result.units.cadence).toBe("rpm");
  });

  it("doubles cadence and reports spm for a Walk (a step-cadence type, not a pace type)", () => {
    const walkActivity: IntervalsActivity = { ...runActivity, type: "Walk" };
    const result = buildActivityStreamsResult(
      walkActivity,
      streams,
      ["cadence"],
      100,
    );

    // Same bucket as the "doubles cadence" run test: 63 raw -> 126 doubled.
    expect(result.streams.cadence?.[0]).toBe(126);
    expect(result.units.cadence).toBe("spm");
  });

  it("returns latlng as [lat, lng] pairs, last point of the bucket, 5 dp", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ALL_TYPES,
      100,
    );

    expect(result.streams.latlng).toHaveLength(100);
    expect(result.streams.latlng?.[0]).toEqual([-33.85679, 151.21524]);
    expect(result.streams.latlng?.[1]).toEqual([-33.85675, 151.21505]);
  });

  it("returns null for a latlng point where the bucket's last sample is null", () => {
    const tiny: IntervalsStream[] = [
      { type: "time", data: [0, 1] },
      { type: "latlng", data: [10, null], data2: [20, null] },
    ];
    const result = buildActivityStreamsResult(runActivity, tiny, ["latlng"], 2);

    expect(result.streams.latlng).toEqual([[10, 20], null]);
  });

  it("still sizes returned_points off the always-fetched time stream when only latlng is requested", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ["latlng"],
      100,
    );

    expect(result.returned_points).toBe(100);
    expect(Object.keys(result.streams)).toEqual(["latlng"]);
  });

  it("omits time from the output when it wasn't requested", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ["heartrate"],
      100,
    );

    expect(Object.keys(result.streams)).toEqual(["heartrate"]);
    expect(result.original_points).toBe(600);
    expect(result.returned_points).toBe(100);
  });

  it("returns every requested type in missing when the streams response has none of them", () => {
    const timeOnly: IntervalsStream[] = [{ type: "time", data: [0, 1, 2] }];
    const result = buildActivityStreamsResult(
      runActivity,
      timeOnly,
      ["heartrate", "watts"],
      100,
    );

    expect(result.missing).toEqual(["heartrate", "watts"]);
    expect(result.streams).toEqual({});
    // units maps returned types only; a fully-missing request yields none.
    expect(result.units).toEqual({});
  });
});

describe("formatActivityStreamsText", () => {
  it("summarizes points, types, and per-stream min/avg/max without the arrays", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ["heartrate", "cadence", "latlng", "watts"],
      100,
    );
    const text = formatActivityStreamsText(result);

    expect(text).toContain("i189807578 Run: 100 of 600 points, 4 types");
    expect(text).toContain("heartrate:");
    expect(text).toContain("bpm");
    expect(text).toContain("latlng: 100 points");
    expect(text).toContain("missing: watts");
    // The summary lines (before the CSV block) never render arrays literally.
    expect(text.split("\nCSV:")[0]).not.toContain("[");
  });

  it("reports the cadence stats line in the activity's actual unit (rpm for a Ride)", () => {
    const rideActivity: IntervalsActivity = { ...runActivity, type: "Ride" };
    const result = buildActivityStreamsResult(
      rideActivity,
      streams,
      ["cadence"],
      100,
    );
    const text = formatActivityStreamsText(result);

    expect(text).toContain("cadence:");
    expect(text).toMatch(/cadence:.*rpm/);
    expect(text).not.toContain("spm");
  });

  it("appends a CSV block with a header row and one row per point", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ["heartrate", "cadence"],
      5,
    );
    const text = formatActivityStreamsText(result);
    const lines = text.split("\n");

    const headerIndex = lines.indexOf("CSV:") + 1;
    expect(lines[headerIndex]).toBe("heartrate_bpm,cadence_spm");
    // 5 data rows follow the header.
    expect(lines.slice(headerIndex + 1)).toHaveLength(5);
    expect(lines[headerIndex + 1]).toBe(
      `${result.streams.heartrate?.[0]},${result.streams.cadence?.[0]}`,
    );
  });

  it("expands latlng into lat,lng CSV columns", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ["latlng"],
      3,
    );
    const text = formatActivityStreamsText(result);
    const lines = text.split("\n");

    const headerIndex = lines.indexOf("CSV:") + 1;
    expect(lines[headerIndex]).toBe("lat,lng");
    const point = result.streams.latlng?.[0] as [number, number] | undefined;
    const [lat, lng] = point ?? [0, 0];
    expect(lines[headerIndex + 1]).toBe(`${lat},${lng}`);
  });

  it("omits a missing type's column from the CSV header", () => {
    const result = buildActivityStreamsResult(
      runActivity,
      streams,
      ["heartrate", "watts"],
      5,
    );
    const text = formatActivityStreamsText(result);
    const lines = text.split("\n");

    const headerIndex = lines.indexOf("CSV:") + 1;
    expect(lines[headerIndex]).toBe("heartrate_bpm");
  });

  it("omits the CSV block entirely when every requested type is missing", () => {
    const timeOnly: IntervalsStream[] = [{ type: "time", data: [0, 1, 2] }];
    const result = buildActivityStreamsResult(
      runActivity,
      timeOnly,
      ["watts"],
      5,
    );
    const text = formatActivityStreamsText(result);

    expect(text).not.toContain("CSV:");
  });
});

describe("getActivityStreamsTool.inputSchema", () => {
  it("defaults maxPoints to 120", () => {
    const parsed = getActivityStreamsTool.inputSchema.parse({
      id: "i189807578",
    });
    expect(parsed.maxPoints).toBe(120);
  });
});

describe("getActivityStreamsTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
    mockedGetActivityStreams.mockReset();
  });

  it("fetches the activity then its streams, always including time in the fetch", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetActivityStreams.mockResolvedValueOnce(streams);

    const result = await getActivityStreamsTool.execute(
      { id: "i189807578", types: ["heartrate"], maxPoints: 100 },
      "key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("key", "i189807578");
    expect(mockedGetActivityStreams).toHaveBeenCalledWith("key", "i189807578", [
      "heartrate",
      "time",
    ]);
    expect(result.isError).toBeUndefined();
    expect(Object.keys(result.structuredContent?.streams ?? {})).toEqual([
      "heartrate",
    ]);
  });

  it("returns structured content matching the fixture at maxPoints 100, watts missing", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetActivityStreams.mockResolvedValueOnce(streams);

    const result = await getActivityStreamsTool.execute(
      { id: "i189807578", types: ALL_TYPES, maxPoints: 100 },
      "key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.original_points).toBe(600);
    expect(result.structuredContent?.returned_points).toBe(100);
    expect(result.structuredContent?.missing).toEqual(["watts"]);
    expect(result.structuredContent?.streams.cadence?.[0]).toBe(126);
    expect(result.structuredContent?.streams.latlng).toHaveLength(100);
  });

  it("fails with the notFound text on a genuine 404 fetching the activity", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledNotFound("getActivity for ID i0"),
    );

    const result = await getActivityStreamsTool.execute(
      { id: "i0", types: ["heartrate"], maxPoints: 100 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
    expect(result.content[0]?.text).toContain("i0 was not found");
  });

  it("fails with a clear isError naming the id when the streams response is empty", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetActivityStreams.mockResolvedValueOnce([]);

    const result = await getActivityStreamsTool.execute(
      { id: "i189807578", types: ["heartrate"], maxPoints: 100 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
    expect(result.content[0]?.text).toContain("i189807578");
    expect(result.content[0]?.text).toContain("no data streams");
  });

  it("renders the rate-limit window on a RateLimitError fetching streams", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetActivityStreams.mockRejectedValueOnce(
      handledRateLimit("getActivityStreams for ID i189807578"),
    );

    const result = await getActivityStreamsTool.execute(
      { id: "i189807578", types: ["heartrate"], maxPoints: 100 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limit");
  });
});
