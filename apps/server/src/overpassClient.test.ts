import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallCancelledError } from "./callScope";
import { HttpError, overpassApi } from "./fetchClient";
import { type RouteTrack } from "./mapAnchors";
import {
  crossingsPerKm,
  loadCrossings,
  SKIP_AFTER_FAILURE_MS,
  snappedBounds,
} from "./overpassClient";

vi.mock("./fetchClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetchClient")>()),
  overpassApi: { get: vi.fn(), evictCached: vi.fn() },
}));

const get = vi.mocked(overpassApi.get);
const evictCached = vi.mocked(overpassApi.evictCached);

/** The skip window's clock: each test starts an hour on, past any earlier test's window. */
let clock = 0;
const now = () => clock;

/** About 880 m due east along latitude 37.79. */
const line: RouteTrack = {
  coordinates: [
    [37.79, -122.39],
    [37.79, -122.38],
  ],
  distance: [0, 880],
  altitude: [0, 0],
};

// Braces: a function returned from beforeEach is run as cleanup, which would call the mock.
beforeEach(() => {
  get.mockReset();
  evictCached.mockReset();
  clock += 60 * 60_000;
});

describe("snappedBounds", () => {
  it("snaps outward to the 0.02 degree grid", () => {
    expect(snappedBounds([line])).toEqual([37.78, -122.4, 37.8, -122.38]);
  });
  it("is null without points", () => {
    expect(
      snappedBounds([{ coordinates: [], distance: [], altitude: [] }]),
    ).toBeNull();
  });
});

describe("crossingsPerKm", () => {
  it("counts nodes within 12 m of the route", () => {
    const nodes: Array<[number, number]> = [
      [37.79, -122.385], // on the line
      [37.79005, -122.385], // about 5.5 m north
      [37.7903, -122.385], // about 33 m north
      [37.79, -122.37], // past the end
    ];
    expect(crossingsPerKm(line, nodes)).toBe(2.3);
  });
  it("counts an edge node east of a high-latitude track", () => {
    // Track ends on the 60.00 / 10.02 grid corner; node ~10 m east of it
    // (0.00018 deg lng is ~10 m at 60 N), outside the old latitude-only pad.
    const north: RouteTrack = {
      coordinates: [
        [60, 10.01],
        [60, 10.02],
      ],
      distance: [0, 555],
      altitude: [0, 0],
    };
    expect(crossingsPerKm(north, [[60, 10.02018]])).toBe(1.8);
  });
  it("is 0 for a track with no length", () => {
    expect(
      crossingsPerKm({ coordinates: [[1, 2]], distance: [0], altitude: [0] }, [
        [1, 2],
      ]),
    ).toBe(0);
  });
});

describe("loadCrossings", () => {
  it("queries the snapped area once and returns lat,lng nodes", async () => {
    get.mockResolvedValue({
      data: JSON.stringify({
        elements: [
          { type: "node", id: 1, lat: 37.79, lon: -122.385 },
          { type: "node", id: 2 },
        ],
      }),
    });
    expect(await loadCrossings([line], now)).toEqual([[37.79, -122.385]]);
    const [path, config] = get.mock.calls[0]!;
    expect(path).toBe("/interpreter");
    const query = String((config as { params: { data: string } }).params.data);
    expect(query).toContain("(37.78,-122.4,37.8,-122.38)");
    expect(query).toContain('highway~"^(crossing|traffic_signals)$"');
  });

  it("is null when Overpass fails", async () => {
    get.mockRejectedValue(
      new HttpError("busy", {
        status: 504,
        statusText: "Gateway Timeout",
        data: "",
      }),
    );
    expect(await loadCrossings([line], now)).toBeNull();
  });

  it("is null when Overpass answers garbage", async () => {
    get.mockResolvedValue({ data: "<html>at capacity</html>" });
    expect(await loadCrossings([line], now)).toBeNull();
  });

  it("stops asking for 10 minutes after a failure, then asks again", async () => {
    get.mockRejectedValue(
      new HttpError("busy", { status: 502, statusText: "", data: "" }),
    );
    expect(await loadCrossings([line], now)).toBeNull();
    clock += SKIP_AFTER_FAILURE_MS - 1;
    expect(await loadCrossings([line], now)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);

    clock += 1;
    get.mockResolvedValue({ data: JSON.stringify({ elements: [] }) });
    expect(await loadCrossings([line], now)).toEqual([]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("treats a 200 with a remark as a failure, evicts it, and refetches after the window", async () => {
    get.mockResolvedValue({
      data: JSON.stringify({
        elements: [],
        remark: 'runtime error: Query timed out in "query" at line 1',
      }),
    });
    expect(await loadCrossings([line], now)).toBeNull();
    const [path, config] = get.mock.calls[0]!;
    expect(evictCached).toHaveBeenCalledWith(
      path,
      (config as { params: unknown }).params,
    );
    expect(await loadCrossings([line], now)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);

    clock += SKIP_AFTER_FAILURE_MS;
    get.mockResolvedValue({
      data: JSON.stringify({ elements: [{ lat: 37.79, lon: -122.385 }] }),
    });
    expect(await loadCrossings([line], now)).toEqual([[37.79, -122.385]]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("rethrows a cancellation", async () => {
    get.mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    await expect(loadCrossings([line], now)).rejects.toThrow(/aborted/);
  });

  it("rethrows a cancelled call without the bounding box, and keeps asking", async () => {
    get.mockRejectedValueOnce(
      new CallCancelledError(
        "Request to https://overpass-api.de/api/interpreter?data=(37.78,-122.4,37.8,-122.38)",
      ),
    );
    const error = await loadCrossings([line], now)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallCancelledError);
    expect((error as Error).message).toBe(
      "Counting road crossings stopped: the tool call was cancelled.",
    );
    expect((error as Error).message).not.toMatch(/\d+\.\d+/);
    get.mockResolvedValue({ data: JSON.stringify({ elements: [] }) });
    expect(await loadCrossings([line], now)).toEqual([]);
  });
});
