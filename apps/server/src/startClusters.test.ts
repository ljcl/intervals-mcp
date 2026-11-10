import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__/errors";
import { CallCancelledError } from "./callScope";
import { HttpError } from "./fetchClient";
import { type IntervalsActivity, listActivities } from "./intervalsClient";
import {
  type IntervalsStreams,
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "./intervalsStreams";
import { type LatLng } from "./mapAnchors";
import {
  clusterStarts,
  loadRunStarts,
  nearestCluster,
  type RunStart,
} from "./startClusters";

vi.mock("./intervalsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intervalsClient")>()),
  listActivities: vi.fn(),
}));
vi.mock("./intervalsStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intervalsStreams")>()),
  loadIntervalsStreams: vi.fn(),
}));

const SF: LatLng = [37.7955, -122.3937];
const NEAR_SF: LatLng = [37.797, -122.3937]; // about 170 m north
const OAKLAND: LatLng = [37.8044, -122.2712];

function run(id: string, date: string, start: LatLng): RunStart {
  return {
    id,
    date,
    name: id,
    distance_m: 6000,
    climb_m: 40,
    track: {
      coordinates: [start, start],
      distance: [0, 6000],
      altitude: [10, 10],
    },
  };
}

describe("clusterStarts", () => {
  it("groups starts within 300 m and ranks by recency-weighted count", () => {
    const clusters = clusterStarts(
      [
        run("a", "2026-11-01", SF),
        run("b", "2026-10-01", NEAR_SF),
        run("c", "2026-11-02", OAKLAND),
      ],
      "2026-11-03",
    );
    expect(clusters.map((c) => c.runs.map((r) => r.id))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(clusters[0]!.center).toEqual(SF);
    expect(clusters[0]!.weight).toBeCloseTo(
      0.5 ** (2 / 60) + 0.5 ** (33 / 60),
      6,
    );
  });

  it("finds the nearest cluster within 300 m only", () => {
    const clusters = clusterStarts([run("a", "2026-11-01", SF)], "2026-11-03");
    expect(nearestCluster(clusters, NEAR_SF)?.runs[0]?.id).toBe("a");
    expect(nearestCluster(clusters, OAKLAND)).toBeNull();
  });
});

describe("loadRunStarts", () => {
  const activities = [
    {
      id: "i3",
      type: "Run",
      start_date_local: "2026-11-02T07:00:00",
      name: "Loop",
      distance: 6000,
      total_elevation_gain: 30,
    },
    {
      id: "i2",
      type: "Run",
      start_date_local: "2026-11-01T07:00:00",
      name: "Treadmill",
      distance: 5000,
    },
    {
      id: "i1",
      type: "Ride",
      start_date_local: "2026-10-31T07:00:00",
      name: "Ride",
      distance: 20000,
    },
    {
      id: "i0",
      type: "TrailRun",
      start_date_local: "2026-10-30T07:00:00",
      name: "Broken",
      distance: 8000,
    },
  ] as IntervalsActivity[];

  const streams = {
    time: [0, 1, 2],
    moving: [true, true, true],
    length: 3,
    latlng: [null, SF, NEAR_SF],
    distance: [0, 0, 170],
    altitude: [5, 6, null],
  } as IntervalsStreams;

  beforeEach(() => {
    vi.mocked(listActivities).mockResolvedValue(activities);
    vi.mocked(loadIntervalsStreams).mockImplementation(async (_key, id) => {
      if (id === "i3") return streams;
      throw new IntervalsStreamsUnavailableError(id);
    });
  });

  it("keeps GPS runs, skips and counts the rest", async () => {
    const { runs, skipped } = await loadRunStarts("k", "2026-11-03");
    expect(runs.map((r) => r.id)).toEqual(["i3"]);
    expect(skipped).toBe(2);
    expect(runs[0]).toMatchObject({
      date: "2026-11-02",
      name: "Loop",
      distance_m: 6000,
      climb_m: 30,
    });
    expect(runs[0]!.track).toEqual({
      coordinates: [SF, NEAR_SF],
      distance: [0, 170],
      altitude: [6, null],
    });
    expect(vi.mocked(listActivities).mock.calls[0]![1]).toEqual({
      oldest: "2026-05-07",
      newest: "2026-11-03",
    });
  });

  it("carries a missing climb as null, not 0", async () => {
    vi.mocked(loadIntervalsStreams).mockResolvedValue(streams);
    const { runs } = await loadRunStarts("k", "2026-11-03");
    expect(runs.find((r) => r.id === "i0")?.climb_m).toBeNull();
  });

  it("fails on a rate limit and starts no further reads", async () => {
    const rateLimit = handledRateLimit("loadIntervalsStreams");
    vi.mocked(loadIntervalsStreams).mockRejectedValue(rateLimit);
    await expect(loadRunStarts("k", "2026-11-03")).rejects.toBe(rateLimit);
    expect(vi.mocked(loadIntervalsStreams)).toHaveBeenCalledTimes(1);
  });

  it("fails on an upstream outage instead of counting the run skipped", async () => {
    const outage = new HttpError("intervals.icu API Error (502)", {
      status: 502,
      statusText: "Bad Gateway",
      data: "",
    });
    vi.mocked(loadIntervalsStreams).mockRejectedValue(outage);
    await expect(loadRunStarts("k", "2026-11-03")).rejects.toBe(outage);
  });

  it("rethrows a cancelled call instead of counting it skipped", async () => {
    vi.mocked(loadIntervalsStreams).mockRejectedValue(
      new CallCancelledError("Reading runs"),
    );
    await expect(loadRunStarts("k", "2026-11-03")).rejects.toBeInstanceOf(
      CallCancelledError,
    );
  });

  it("rethrows an abort error", async () => {
    vi.mocked(loadIntervalsStreams).mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );
    await expect(loadRunStarts("k", "2026-11-03")).rejects.toThrow("aborted");
  });
});
