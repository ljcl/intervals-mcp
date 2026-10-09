/**
 * bestEffortWindows: intervals.icu's pace-curve rule over one activity's
 * time and distance streams. The golden test pins it to a real activity
 * pace curve (`activity-pace-curve.json`, read from the same run as
 * `streams-time-distance.json`, docs/api-notes.md).
 */
import { describe, expect, it, vi } from "vitest";
import activityPaceCurveFixture from "./__fixtures__/intervals/activity-pace-curve.json";
import streamsTimeDistanceFixture from "./__fixtures__/intervals/streams-time-distance.json";
import {
  bestEffortWindows,
  coveredDistanceM,
  type EffortStreams,
  paceIgnoredMask,
} from "./activityBestEfforts";
import { intervalsApi } from "./fetchClient";
import { loadIntervalsStreams } from "./intervalsStreams";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return { ...actual, intervalsApi: { get: vi.fn() } };
});

type RawStream = { type: string; data: (number | null)[] };

const raw = streamsTimeDistanceFixture as RawStream[];
const fixtureTime = raw.find((s) => s.type === "time")?.data as number[];
const fixtureDistance = raw.find((s) => s.type === "distance")?.data ?? [];

const curve = activityPaceCurveFixture as unknown as {
  distance: number[];
  values: number[];
  start_index: number[];
  end_index: number[];
};

/** Streams with no stop anywhere, for tests that do not read stops. */
function streamsOf(time: number[], distance: (number | null)[]): EffortStreams {
  return { time, distance, moving: time.map(() => true) };
}

const fixtureStreams = streamsOf(fixtureTime, fixtureDistance);

/** `n` + 1 samples at 1 Hz, `speed` m/s from 0 m. */
function steady(n: number, speed: number) {
  const time = Array.from({ length: n + 1 }, (_, k) => k);
  return { time, distance: time.map((t) => t * speed) };
}

describe("bestEffortWindows", () => {
  it("reproduces every point of intervals.icu's activity pace curve, with the same sample indices", () => {
    // Also measured on two longer runs with auto-pause stops before the
    // fixtures were chosen: 232 of 232 values (docs/api-notes.md).
    expect(curve.distance.length).toBeGreaterThan(50);
    curve.distance.forEach((target, k) => {
      const [best] = bestEffortWindows(fixtureStreams, target, 1);
      expect(Math.round(best?.seconds ?? Number.NaN), `${target} m`).toBe(
        curve.values[k],
      );
      expect(best?.startIndex, `${target} m start`).toBe(curve.start_index[k]);
      expect(best?.endIndex, `${target} m end`).toBe(curve.end_index[k]);
    });
  });

  it("finds the fastest stretches that do not overlap, fastest first", () => {
    const at = (target: number) =>
      bestEffortWindows(fixtureStreams, target, 3).map((w) => ({
        seconds: Math.round(w.seconds),
        startKm: Math.round(w.startM / 10) / 100,
      }));

    expect(at(400).map((w) => w.seconds)).toEqual([119, 121, 122]);
    expect(at(1000)).toEqual([
      { seconds: 312, startKm: 1.43 },
      { seconds: 315, startKm: 3.4 },
      { seconds: 320, startKm: 4.98 },
    ]);

    // A 6.1 km run holds one 5 km stretch: any other would overlap it.
    const fiveK = bestEffortWindows(fixtureStreams, 5000, 3);
    expect(fiveK).toHaveLength(1);
    expect(fiveK[0]).toMatchObject({ startIndex: 273, endIndex: 1898 });
    expect(Math.round(fiveK[0]!.seconds)).toBe(1625);
    expect(Math.round(fiveK[0]!.startM / 10) / 100).toBe(0.87);
    expect(Math.round(fiveK[0]!.endM / 10) / 100).toBe(5.87);
  });

  it("gives a steady run its exact time, and the earliest start on a tie", () => {
    const { time, distance } = steady(300, 4);
    const [best, second] = bestEffortWindows(
      streamsOf(time, distance),
      1000,
      2,
    );

    expect(best).toMatchObject({
      startIndex: 0,
      endIndex: 250,
      seconds: 250,
      startM: 0,
      endM: 1000,
      stoppedSeconds: 0,
    });
    // 1,200 m holds one 1,000 m stretch only.
    expect(second).toBeUndefined();
  });

  it("scales a stretch that overshoots the target to exactly the target", () => {
    // 3 m/s, sampled every 2 s: 6 m steps never land on 10 m exactly.
    const time = [0, 2, 4, 6];
    const distance = [0, 6, 12, 18];

    const [best] = bestEffortWindows(streamsOf(time, distance), 10, 1);

    // Samples 0 to 2 span 12 m in 4 s; 10 m of that takes 10/3 s.
    expect(best?.startIndex).toBe(0);
    expect(best?.endIndex).toBe(2);
    expect(best?.seconds).toBeCloseTo(10 / 3, 9);
  });

  it("counts a stop inside the stretch as elapsed time and reports it as stopped (moving from the stream loader)", async () => {
    // 200 m at 4 m/s, a 60 s auto-pause gap with 4 m across it, then 196 m.
    const time = [
      ...Array.from({ length: 51 }, (_, k) => k),
      ...Array.from({ length: 50 }, (_, k) => 110 + k),
    ];
    const distance = [
      ...Array.from({ length: 51 }, (_, k) => k * 4),
      ...Array.from({ length: 50 }, (_, k) => 204 + k * 4),
    ];
    vi.mocked(intervalsApi.get).mockResolvedValueOnce({
      data: [
        { type: "time", data: time },
        { type: "distance", data: distance },
      ],
    } as never);
    const streams = await loadIntervalsStreams("key", "i1", ["distance"]);

    const [best] = bestEffortWindows(
      {
        time: streams.time,
        distance: streams.distance ?? [],
        moving: streams.moving,
      },
      396,
      1,
    );

    // Every 396 m stretch spans the gap: 98 s running plus 60 s stopped.
    expect(streams.moving[51]).toBe(false);
    expect(best).toMatchObject({ startIndex: 0, endIndex: 99 });
    expect(best?.seconds).toBe(158);
    expect(best?.stoppedSeconds).toBe(60);
  });

  it("keeps stretches apart, though two may share an end sample", () => {
    // Three fast 100 m blocks (5 m/s) between slow running (2 m/s).
    const speeds = [
      ...Array(20).fill(5),
      ...Array(50).fill(2),
      ...Array(20).fill(5),
      ...Array(50).fill(2),
      ...Array(20).fill(5),
    ] as number[];
    const time = [0];
    const distance = [0];
    for (const v of speeds) {
      time.push(time.length);
      distance.push((distance.at(-1) as number) + v);
    }

    const windows = bestEffortWindows(streamsOf(time, distance), 100, 3);

    expect(windows.map((w) => w.seconds)).toEqual([20, 20, 20]);
    const ranges = windows
      .map((w) => [w.startIndex, w.endIndex] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(ranges).toEqual([
      [0, 20],
      [70, 90],
      [140, 160],
    ]);
    for (let k = 1; k < ranges.length; k += 1) {
      expect(ranges[k]![0]).toBeGreaterThanOrEqual(ranges[k - 1]![1]);
    }

    // Steady running: the second 400 m starts on the sample where the first
    // one ends.
    const { time: t2, distance: d2 } = steady(200, 4);
    const pair = bestEffortWindows(streamsOf(t2, d2), 400, 2);
    expect(pair.map((w) => [w.startIndex, w.endIndex])).toEqual([
      [0, 100],
      [100, 200],
    ]);
  });

  it("returns fewer stretches than asked when fewer fit", () => {
    const { time, distance } = steady(375, 4);
    expect(bestEffortWindows(streamsOf(time, distance), 1000, 3)).toHaveLength(
      1,
    );
  });

  it("returns none when the run is shorter than the target", () => {
    const { time, distance } = steady(200, 4);
    expect(bestEffortWindows(streamsOf(time, distance), 1000, 1)).toEqual([]);
    expect(bestEffortWindows(streamsOf(time, [null, null]), 1, 1)).toEqual([]);
  });

  it("skips starts with no distance and measures km from the first known sample", () => {
    const time = [0, 1, 2, 3, 4, 5, 6];
    const distance = [null, null, 10, 14, 18, 22, 26];

    const [best] = bestEffortWindows(streamsOf(time, distance), 8, 1);

    expect(best).toMatchObject({
      startIndex: 2,
      endIndex: 4,
      seconds: 2,
      startM: 0,
      endM: 8,
    });
  });

  it("never picks a stretch that touches an excluded sample", () => {
    const { time, distance } = steady(100, 4);
    // The first 40 s are faster: 5 m/s.
    for (let k = 1; k <= 40; k += 1) distance[k] = k * 5;
    for (let k = 41; k <= 100; k += 1) distance[k] = 200 + (k - 40) * 4;
    const streams = streamsOf(time, distance);

    expect(bestEffortWindows(streams, 100, 1)[0]?.startIndex).toBe(0);

    // Sample 10 is inside every fast stretch that starts at 0 to 10.
    const excluded = time.map((_, k) => k === 10);
    const [best] = bestEffortWindows(streams, 100, 1, excluded);
    expect(best?.seconds).toBe(20);
    expect(best?.startIndex).toBe(11);

    const all = time.map(() => true);
    expect(bestEffortWindows(streams, 100, 1, all)).toEqual([]);
  });
});

describe("coveredDistanceM", () => {
  it("is the last known distance minus the first known one", () => {
    expect(coveredDistanceM([null, 5, 10, null, 105, null])).toBe(100);
    expect(coveredDistanceM(fixtureDistance)).toBeCloseTo(6119.64, 2);
  });

  it("is 0 with no known sample", () => {
    expect(coveredDistanceM([])).toBe(0);
    expect(coveredDistanceM([null, null])).toBe(0);
  });
});

describe("paceIgnoredMask", () => {
  it("returns null when no part is ignored for pace", () => {
    expect(paceIgnoredMask(null, 10)).toBeNull();
    expect(paceIgnoredMask(undefined, 10)).toBeNull();
    expect(paceIgnoredMask([], 10)).toBeNull();
    expect(
      paceIgnoredMask([{ start_index: 1, end_index: 3, pace: false }], 10),
    ).toBeNull();
    expect(
      paceIgnoredMask([{ start_index: 1, end_index: 3, hr: true }], 10),
    ).toBeNull();
  });

  it("marks each pace part, both ends included, clamped to the streams", () => {
    const result = paceIgnoredMask(
      [
        { start_index: 1, end_index: 2, pace: true },
        { start_index: 8, end_index: 50, pace: true, hr: true },
      ],
      10,
    );

    expect(result?.parts).toBe(2);
    expect(result?.mask).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("treats a value that does not parse as no ignored parts", () => {
    expect(paceIgnoredMask("1-3", 10)).toBeNull();
    expect(paceIgnoredMask({ start_index: 1 }, 10)).toBeNull();
    expect(
      paceIgnoredMask([{ start_index: "1", end_index: 3, pace: true }], 10),
    ).toBeNull();
    expect(
      paceIgnoredMask([{ start_index: 4, end_index: 2, pace: true }], 10),
    ).toBeNull();
    expect(paceIgnoredMask([{ pace: true }], 10)).toBeNull();
    expect(
      paceIgnoredMask([{ start_index: 1, end_index: 3, pace: true }], 0),
    ).toBeNull();
  });
});
