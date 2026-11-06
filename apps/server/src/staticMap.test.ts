import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type RouteMapData } from "./routeMapData";
import {
  renderRoutePng,
  STATIC_MAP_HEIGHT,
  STATIC_MAP_WIDTH,
} from "./staticMap";

function data(
  coordinates: Array<[number, number]>,
  extra: Partial<RouteMapData> = {},
): RouteMapData {
  return {
    source: "activity",
    id: "i1",
    name: "Run",
    activityType: "Run",
    distance: 1000,
    elevationGain: 0,
    coordinates,
    start: coordinates[0] ?? null,
    end: coordinates.at(-1) ?? null,
    ...extra,
  };
}

/** The PNG's chunk types in order, and its pixels (one palette index each). */
function decode(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const types: string[] = [];
  let width = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    types.push(type);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR")
      width = new DataView(body.buffer, body.byteOffset).getUint32(0);
    if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const pixels = new Set<number>();
  for (let y = 0; y < rows.length / (width + 1); y++)
    for (let x = 1; x <= width; x++) pixels.add(rows[y * (width + 1) + x]!);
  return { types, width, pixels, rows: rows.length / (width + 1) };
}

describe("renderRoutePng", () => {
  it("draws a palette PNG of the track", () => {
    const png = renderRoutePng(
      data([
        [-33.86, 151.17],
        [-33.86, 151.18],
        [-33.85, 151.18],
      ]),
    )!;
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const { types, width, rows, pixels } = decode(png);
    expect(types).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
    expect(width).toBe(STATIC_MAP_WIDTH);
    expect(rows).toBe(STATIC_MAP_HEIGHT);
    // Background, grid, the line, start and finish at least.
    expect(pixels.size).toBeGreaterThanOrEqual(5);
  });

  it("draws sections, km dots, vias, pins and a compared version", () => {
    const coordinates: Array<[number, number]> = [
      [-33.86, 151.17],
      [-33.86, 151.175],
      [-33.86, 151.18],
      [-33.855, 151.18],
    ];
    const png = renderRoutePng(
      data(coordinates, {
        source: "route",
        annotations: {
          waypoints: [
            {
              km: 0.2,
              end_km: 0.6,
              label: "Climb",
              kind: "climb",
              index: 1,
              endIndex: 2,
            },
          ],
        },
        route: {
          route_id: "rabcdefghij",
          version: 2,
          latest_version: 2,
          versions: [],
          editable: true,
          segments: [
            {
              index: 1,
              kind: "activity",
              label: "A",
              from_km: 0,
              to_km: 0.5,
              startIndex: 0,
              endIndex: 1,
              climb_m: 0,
              path_share: null,
              notes: [],
            },
            {
              index: 2,
              kind: "generated",
              label: "B",
              from_km: 0.5,
              to_km: 1.5,
              startIndex: 1,
              endIndex: 3,
              climb_m: 0,
              path_share: 0.5,
              notes: [],
            },
          ],
          vias: [
            {
              id: "v1",
              km: 1,
              label: "Via",
              kind: "via",
              index: 2,
              point: [-33.86, 151.18],
            },
          ],
          kmMarkers: [{ km: 1, index: 2 }],
          warnings: [],
          compare: {
            version: 1,
            coordinates: [
              [-33.86, 151.17],
              [-33.865, 151.18],
            ],
            change: {
              from_version: 1,
              to_version: 2,
              distance_change_m: 100,
              changed: true,
              from_km: 0.5,
              to_km: 1.5,
              old_from_km: 0.5,
              old_to_km: 1.2,
            },
            startIndex: 1,
            endIndex: 3,
          },
        },
      }),
    )!;
    expect(decode(png).pixels.size).toBeGreaterThanOrEqual(9);
  });

  it("draws nothing for fewer than two points", () => {
    expect(renderRoutePng(data([[-33.86, 151.17]]))).toBeNull();
  });
});
