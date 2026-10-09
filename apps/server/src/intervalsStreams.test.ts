/**
 * loadIntervalsStreams: turns the raw `getActivityStreams` stream array into
 * named, index-aligned arrays and derives `moving`, which intervals.icu
 * never returns (docs research 2026-09-24).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import streamsFixture from "./__fixtures__/intervals/streams.json";
import streamsHillyFixture from "./__fixtures__/intervals/streams-hilly.json";
import streamsHrDropoutFixture from "./__fixtures__/intervals/streams-hr-dropout.json";
import streamsMultilapFixture from "./__fixtures__/intervals/streams-multilap.json";
import { HttpError, intervalsApi, RateLimitError } from "./fetchClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
  MOVING_GAP_THRESHOLD_SECONDS,
  MOVING_MIN_VELOCITY_MPS,
} from "./intervalsStreams";
import { computeSplitAnalysis } from "./splitAnalysis";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return { ...actual, intervalsApi: { get: vi.fn() } };
});

const mockedGet = vi.mocked(intervalsApi.get);

const notFound = () =>
  new HttpError("HTTP 404: Not Found", {
    status: 404,
    statusText: "Not Found",
    data: "Not Found",
  });

const rateLimited = () =>
  new RateLimitError(
    "15-minute rate limit reached (100/100 requests).",
    { status: 429, statusText: "Too Many Requests", data: "" },
    { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
    60,
  );

const serverError = () =>
  new HttpError("HTTP 500", {
    status: 500,
    statusText: "Internal Server Error",
    data: "",
  });

beforeEach(() => {
  mockedGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadIntervalsStreams", () => {
  it("returns the named-array shape from a real fixture", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsFixture });

    const streams = await loadIntervalsStreams("key", "i1", [
      "time",
      "distance",
      "heartrate",
      "altitude",
      "velocity_smooth",
      "cadence",
      "latlng",
    ]);

    expect(streams.time).toHaveLength(600);
    expect(streams.time[0]).toBe(0);
    expect(streams.distance).toHaveLength(600);
    expect(streams.heartrate).toHaveLength(600);
    expect(streams.altitude).toHaveLength(600);
    expect(streams.velocity_smooth).toHaveLength(600);
    expect(streams.cadence).toHaveLength(600);
    expect(streams.latlng).toHaveLength(600);
    expect(streams.latlng?.[0]).toBeNull();
    expect(streams.latlng?.[2]).toEqual([-33.8568, 151.2153]);
    expect(streams.moving).toHaveLength(600);
    expect(streams.length).toBe(600);
    // Not requested: absent, not present-with-undefined.
    expect(Object.hasOwn(streams, "watts")).toBe(false);
    expect(Object.hasOwn(streams, "grade_smooth")).toBe(false);
  });

  it("returns running-dynamics streams when requested", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsFixture });

    const streams = await loadIntervalsStreams("key", "i1", [
      "time",
      "stance_time",
      "vertical_oscillation",
      "vertical_ratio",
      "step_length",
    ]);

    expect(streams.stance_time).toHaveLength(600);
    expect(streams.vertical_oscillation).toHaveLength(600);
    expect(streams.vertical_ratio).toHaveLength(600);
    expect(streams.step_length).toHaveLength(600);
    expect(streams.stance_time?.some((v) => v === null)).toBe(true);
  });

  it("keeps nulls in the requested arrays other than time", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsFixture });

    const streams = await loadIntervalsStreams("key", "i1", [
      "time",
      "distance",
    ]);

    // streams.json's distance stream carries nulls (verified in fixture).
    expect(streams.distance?.some((v) => v === null)).toBe(true);
  });

  it("only requests the types passed in, plus time and distance for moving", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { type: "time", data: [0, 1, 2] },
        { type: "heartrate", data: [100, 110, 120] },
        { type: "distance", data: [0, 3, 6] },
      ],
    });

    const streams = await loadIntervalsStreams("key", "i1", ["heartrate"]);

    expect(mockedGet).toHaveBeenCalledWith(
      "/activity/i1/streams.json?types=time,heartrate,distance",
      expect.anything(),
    );
    // Fetched for `moving` only: not returned to a caller that did not ask.
    expect(Object.hasOwn(streams, "distance")).toBe(false);
  });

  it("does not duplicate time or distance when the caller already requested them", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { type: "time", data: [0, 1, 2] },
        { type: "distance", data: [0, 3, 6] },
      ],
    });

    const streams = await loadIntervalsStreams("key", "i1", [
      "distance",
      "time",
    ]);

    expect(mockedGet).toHaveBeenCalledWith(
      "/activity/i1/streams.json?types=distance,time",
      expect.anything(),
    );
    expect(streams.distance).toEqual([0, 3, 6]);
  });

  describe("derived moving", () => {
    it("marks the sample after an auto-pause gap as not moving", async () => {
      // Gap from t=10 to t=70: a 60 s auto-pause, well past the 5 s
      // threshold, with no distance covered, so the resume sample (index 2)
      // is stopped.
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [9, 10, 70, 71] },
          { type: "distance", data: [30, 33, 33, 36] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, false, true]);
    });

    it("still marks a gap as not moving when the runner drifted a little across it", async () => {
      // 20 m in 60 s (0.33 m/s): GPS drift or a shuffle at a crossing, below
      // MOVING_MIN_VELOCITY_MPS, so still a stop.
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [9, 10, 70, 71] },
          { type: "distance", data: [30, 33, 53, 56] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, false, true]);
    });

    it("keeps a gap covered at running speed as moving (smart recording)", async () => {
      // 8 s gaps at 3.33 m/s: sparse sampling, not a pause (#73).
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 8, 16, 17] },
          { type: "distance", data: [0, 26.7, 53.3, 56.7] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, true, true]);
    });

    it("keeps a paused stretch walked at over the speed floor as moving", async () => {
      // 72 m in 60 s (1.2 m/s): the runner walked on while the watch was
      // paused. The distance is real, so its time counts too.
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [9, 10, 70, 71] },
          { type: "distance", data: [30, 33, 105, 108] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, true, true]);
    });

    it("falls back to the gap alone when distance is unknown across it", async () => {
      // No distance stream at all (index 2), and a null distance sample at
      // the far end of the second gap (index 4): no way to tell a pause from
      // sparse sampling, so each gap counts as a stop, as before #73.
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "time", data: [9, 10, 70, 71, 131, 132] }],
      });
      const noDistance = await loadIntervalsStreams("key", "i1", ["time"]);
      expect(noDistance.moving).toEqual([true, true, false, true, false, true]);

      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [9, 10, 70, 71, 131, 132] },
          { type: "distance", data: [30, 33, 233, 236, null, 439] },
        ],
      });
      const nullDistance = await loadIntervalsStreams("key", "i1", ["time"]);
      expect(nullDistance.moving).toEqual([
        true,
        true,
        true,
        true,
        false,
        true,
      ]);
    });

    it("lets a known low velocity mark a gap as stopped even when distance says moving", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 8, 16] },
          { type: "distance", data: [0, 26.7, 53.3] },
          { type: "velocity_smooth", data: [3.3, 3.3, 0.2] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving).toEqual([true, true, false]);
    });

    it("catches the multi-lap fixture's real 74 s auto-pause from its flat distance", async () => {
      mockedGet.mockResolvedValueOnce({ data: streamsMultilapFixture });

      // Distance is not requested; the loader fetches it for `moving` anyway.
      const streams = await loadIntervalsStreams("key", "i3", [
        "time",
        "heartrate",
      ]);

      // t=164 -> t=238 at index 165, distance flat at 525.92 m, velocity
      // null throughout. The 3 s and 4 s gaps later on stay under the
      // threshold.
      expect(streams.time.slice(164, 166)).toEqual([164, 238]);
      expect(streams.moving[165]).toBe(false);
      expect(streams.moving.filter((moving) => !moving)).toHaveLength(1);
    });

    it("does not flag a normal 1 s cadence gap", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "time", data: [0, 1, 2, 3] }],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, true, true]);
    });

    it("marks a low-velocity stop as not moving even without a time gap", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1, 2, 3] },
          {
            type: "velocity_smooth",
            data: [3, 3, 0.2, 3],
          },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving).toEqual([true, true, false, true]);
    });

    it("treats moving[0] as true when velocity at 0 is unknown or at/above threshold", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1] },
          { type: "velocity_smooth", data: [MOVING_MIN_VELOCITY_MPS, 3] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving[0]).toBe(true);
    });

    it("treats moving[0] as false when velocity at 0 is below threshold", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1] },
          { type: "velocity_smooth", data: [0.1, 3] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving[0]).toBe(false);
    });

    it("does not flag a null velocity sample as stopped by itself", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1, 2] },
          { type: "velocity_smooth", data: [3, null, 3] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving).toEqual([true, true, true]);
    });

    it("respects the exported threshold constants", () => {
      expect(MOVING_GAP_THRESHOLD_SECONDS).toBe(5);
      expect(MOVING_MIN_VELOCITY_MPS).toBe(0.5);
    });

    it("gives a steady smart-recording run its real pace in split analysis (#73)", async () => {
      // A steady 5:00/km 10 km run (3,000 s), sampled every 1 to 8 s like
      // Garmin smart recording. 249 of the gaps are over the 5 s threshold;
      // counted as stops, split analysis kept their distance but dropped
      // their time: 1,257 s of moving time, a 2:06/km average.
      const time = [0];
      for (let i = 0; time.at(-1)! < 3000; i++) {
        time.push(Math.min(time.at(-1)! + (i % 8) + 1, 3000));
      }
      const speed = 10_000 / 3000;
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: time },
          { type: "distance", data: time.map((t) => t * speed) },
          { type: "velocity_smooth", data: time.map(() => speed) },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i4", [
        "distance",
        "velocity_smooth",
      ]);
      const gaps = time.filter(
        (t, i) => i > 0 && t - time[i - 1]! > MOVING_GAP_THRESHOLD_SECONDS,
      );
      expect(gaps).toHaveLength(249);
      expect(streams.moving.every(Boolean)).toBe(true);

      const analysis = computeSplitAnalysis({
        time: streams.time,
        distance: streams.distance ?? [],
        velocity_smooth: streams.velocity_smooth,
        moving: streams.moving,
      });

      expect(analysis.totals.distanceM).toBe(10_000);
      expect(analysis.totals.movingTimeS).toBe(3000);
      expect(analysis.totals.avgPaceSecPerKm).toBe(300);
      expect(analysis.splits).toHaveLength(10);
      for (const split of analysis.splits) {
        expect(split.paceSecPerKm).toBe(300);
      }
    });
  });

  describe("null time samples", () => {
    it("drops indices where time is null and keeps other arrays aligned", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, null, 2, 3] },
          { type: "heartrate", data: [100, 105, 110, 115] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "heartrate",
      ]);

      expect(streams.time).toEqual([0, 2, 3]);
      expect(streams.heartrate).toEqual([100, 110, 115]);
      expect(streams.length).toBe(3);
      // A caller holding raw indices (ignore_parts) must know they shifted.
      expect(streams.droppedSamples).toBe(1);
    });

    it("throws IntervalsStreamsUnavailableError when every time sample is null", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "time", data: [null, null] }],
      });

      await expect(
        loadIntervalsStreams("key", "i1", ["time"]),
      ).rejects.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });
  });

  describe("heart-rate dropouts", () => {
    const rawData = (type: string) =>
      streamsHrDropoutFixture.find((stream) => stream.type === type)?.data;

    it("maps the fixture's 0 bpm dropout to null and keeps the samples around it", async () => {
      mockedGet.mockResolvedValueOnce({ data: streamsHrDropoutFixture });

      const streams = await loadIntervalsStreams("key", "i2", [
        "time",
        "heartrate",
        "cadence",
        "watts",
      ]);

      // The sensor lost contact at samples 26-71 while the runner kept
      // going, and intervals.icu sends those samples as 0 bpm.
      expect(rawData("heartrate")?.slice(26, 72)).toEqual(Array(46).fill(0));
      expect(streams.heartrate).toHaveLength(104);
      expect(streams.heartrate?.slice(26, 72)).toEqual(Array(46).fill(null));
      expect(streams.heartrate?.[25]).toBe(138);
      expect(streams.heartrate?.[72]).toBe(154);
      expect(streams.heartrate?.some((hr) => hr !== null && hr <= 0)).toBe(
        false,
      );
      // Cadence and power carry on through the dropout, untouched.
      expect(streams.cadence).toEqual(rawData("cadence"));
      expect(streams.watts).toEqual(rawData("watts"));
    });

    it("maps a 0 or negative heart rate to null, but keeps 0 W and 0 cadence", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1, 2, 3, 4, 5] },
          // Samples 1-2: a stop, where 0 W and 0 cadence are real values.
          // Samples 3-4: a heart-rate dropout, sent as 0 and as a negative.
          { type: "heartrate", data: [150, 151, 152, 0, -1, 153] },
          { type: "watts", data: [240, 0, 0, 245, 250, 248] },
          { type: "cadence", data: [86, 0, 0, 87, 88, 87] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "heartrate",
        "watts",
        "cadence",
      ]);

      expect(streams.heartrate).toEqual([150, 151, 152, null, null, 153]);
      expect(streams.watts).toEqual([240, 0, 0, 245, 250, 248]);
      expect(streams.cadence).toEqual([86, 0, 0, 87, 88, 87]);
    });
  });

  describe("unavailable streams", () => {
    it("throws IntervalsStreamsUnavailableError on a 404", async () => {
      mockedGet.mockRejectedValueOnce(notFound());

      const error = await loadIntervalsStreams("key", "i189807578", [
        "time",
      ]).catch((e) => e);

      expect(error).toBeInstanceOf(IntervalsStreamsUnavailableError);
      expect((error as IntervalsStreamsUnavailableError).activityId).toBe(
        "i189807578",
      );
    });

    it("throws IntervalsStreamsUnavailableError on an empty response", async () => {
      mockedGet.mockResolvedValueOnce({ data: [] });

      await expect(
        loadIntervalsStreams("key", "i1", ["time"]),
      ).rejects.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });

    it("throws IntervalsStreamsUnavailableError when the response has no time stream", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "heartrate", data: [100, 110] }],
      });

      await expect(
        loadIntervalsStreams("key", "i1", ["heartrate"]),
      ).rejects.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });
  });

  describe("other failures propagate", () => {
    it("propagates a rate-limit failure intact", async () => {
      mockedGet.mockRejectedValueOnce(rateLimited());

      const error = await loadIntervalsStreams("key", "i1", ["time"]).catch(
        (e) => e,
      );

      expect(error).toBeInstanceOf(RateLimitError);
      expect(error).not.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });

    it("propagates a server error rather than reporting unavailable streams", async () => {
      mockedGet.mockRejectedValueOnce(serverError());

      const error = await loadIntervalsStreams("key", "i1", ["time"]).catch(
        (e) => e,
      );

      expect(error).not.toBeInstanceOf(IntervalsStreamsUnavailableError);
      expect((error as Error).message).toContain("500");
    });
  });

  it("calls getActivityStreams once", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ type: "time", data: [0, 1] }],
    });

    await loadIntervalsStreams("key", "i1", ["time"]);

    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("produces the hilly fixture's shape too (no nulls in that fixture)", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsHillyFixture });

    const streams = await loadIntervalsStreams("key", "i2", [
      "time",
      "grade_smooth",
      "watts",
    ]);

    expect(streams.grade_smooth).toHaveLength(600);
    expect(streams.watts).toHaveLength(600);
  });
});
