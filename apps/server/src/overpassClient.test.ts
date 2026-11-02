import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, overpassApi } from "./fetchClient";
import { type RouteTrack } from "./mapAnchors";
import { crossingsPerKm, loadCrossings, snappedBounds } from "./overpassClient";

vi.mock("./fetchClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetchClient")>()),
  overpassApi: { get: vi.fn() },
}));

const get = vi.mocked(overpassApi.get);

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
    expect(await loadCrossings([line])).toEqual([[37.79, -122.385]]);
    const [path, config] = get.mock.calls[0]!;
    expect(path).toBe("/interpreter");
    const query = String((config as { params: { data: string } }).params.data);
    expect(query).toContain("(37.78,-122.4,37.8,-122.38)");
    expect(query).toContain('highway~"^(crossing|traffic_signals)$"');
  });

  it("is null when Overpass fails or answers garbage", async () => {
    get.mockRejectedValue(
      new HttpError("busy", {
        status: 504,
        statusText: "Gateway Timeout",
        data: "",
      }),
    );
    expect(await loadCrossings([line])).toBeNull();
    get.mockResolvedValue({ data: "<html>at capacity</html>" });
    expect(await loadCrossings([line])).toBeNull();
  });

  it("rethrows a cancellation", async () => {
    get.mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    await expect(loadCrossings([line])).rejects.toThrow(/aborted/);
  });
});
