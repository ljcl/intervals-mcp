import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FixtureExtract, osmPbfBytes } from "./__fixtures__/osmPbf";
import { areaAround, areaKey } from "./osmIndex";
import { buildOsmIndex, mergeStops, wayClass } from "./osmIndexBuild";

const HOME: [number, number] = [-33.87, 151.2];
const AREA = areaAround(HOME, 25);
/** A point `x` m east and `y` m north of HOME. */
const at = (x: number, y: number) => ({
  lat: HOME[0] + y / 110_540,
  lon: HOME[1] + x / (111_320 * Math.cos((HOME[0] * Math.PI) / 180)),
});
const SOURCE = {
  url: "https://example.org/x.osm.pbf",
  etag: '"e1"',
  last_modified: "Sat, 31 Oct 2026 16:21:44 GMT",
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "osm-build-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function build(x: FixtureExtract) {
  const pbf = join(dir, "x.osm.pbf");
  const db = join(dir, "index.sqlite");
  await writeFile(pbf, osmPbfBytes(x));
  const result = await buildOsmIndex(
    pbf,
    db,
    AREA,
    SOURCE,
    Date.parse("2026-11-08T00:00:00Z"),
  );
  return { result, db: new DatabaseSync(db, { readOnly: true }) };
}

describe("wayClass", () => {
  it.each([
    [{ highway: "footway" }, "path"],
    [{ highway: "path" }, "path"],
    [{ highway: "pedestrian" }, "path"],
    [{ highway: "track" }, "path"],
    [{ highway: "cycleway", foot: "designated" }, "path"],
    [{ highway: "cycleway", foot: "yes" }, "path"],
    [{ highway: "cycleway", designation: "shared_path" }, "path"],
    [{ highway: "cycleway" }, null],
    [{ highway: "footway", footway: "sidewalk" }, null],
    [{ highway: "footway", footway: "crossing" }, null],
    [{ highway: "path", foot: "no" }, null],
    [{ highway: "footway", access: "private" }, null],
    [{ highway: "footway", access: "private", foot: "yes" }, "path"],
    [{ highway: "residential" }, null],
    [{ highway: "primary" }, "main_road"],
    [{ highway: "trunk_link" }, "main_road"],
    [{ highway: "secondary" }, "main_road"],
    [{ leisure: "park" }, "green_edge"],
    [{ natural: "water" }, "green_edge"],
    [{ natural: "coastline" }, "green_edge"],
    [{ waterway: "river" }, "green_edge"],
    [{ waterway: "stream" }, "green_edge"],
    [{ waterway: "drain" }, null],
    [{ waterway: "ditch" }, null],
    [{ waterway: "river", tunnel: "culvert" }, null],
    [{ waterway: "stream", tunnel: "yes" }, null],
  ] as const)("%o is %s", (tags, expected) => {
    expect(wayClass(tags)).toBe(expected);
  });
});

describe("mergeStops", () => {
  it("joins nodes chained under 25 m into one stop", () => {
    const signal = { ...at(0, 0), signal: true };
    const near = { ...at(15, 0), signal: false };
    const chained = { ...at(30, 0), signal: false };
    const apart = { ...at(70, 0), signal: false };
    const ids = mergeStops(
      [signal, near, chained, apart].map((n) => ({
        lat: n.lat,
        lng: n.lon,
        signal: n.signal,
      })),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[3]).not.toBe(ids[0]);
  });
});

describe("buildOsmIndex", () => {
  const far = { lat: HOME[0] + 1, lon: HOME[1] };
  const EXTRACT: FixtureExtract = {
    replicationTimestamp: Date.parse("2026-11-01T00:00:00Z") / 1000,
    nodes: [
      { id: 1, ...at(0, 0) },
      { id: 2, ...at(100, 0) },
      { id: 3, ...far },
      { id: 4, ...at(0, 100) },
      { id: 5, ...at(100, 100) },
      { id: 6, ...at(500, 0), tags: { highway: "traffic_signals" } },
      { id: 7, ...at(510, 5), tags: { highway: "crossing" } },
      {
        id: 8,
        ...at(800, 0),
        tags: { highway: "crossing", crossing: "uncontrolled" },
      },
      { id: 9, ...at(0, 300) },
      { id: 10, ...at(100, 300) },
      { id: 11, ...far, tags: { highway: "crossing" } },
    ],
    ways: [
      { id: 100, refs: [1, 2, 3], tags: { highway: "footway" } },
      { id: 101, refs: [1, 4, 5, 2, 1], tags: { leisure: "park" } },
      { id: 102, refs: [1, 4, 5, 2, 1], tags: { natural: "coastline" } },
      { id: 103, refs: [9, 10] },
      { id: 104, refs: [3, 3], tags: { highway: "primary" } },
    ],
    relations: [
      {
        id: 500,
        tags: { type: "multipolygon", natural: "water" },
        members: [{ type: "way", ref: 103, role: "outer" }],
      },
    ],
  };

  it("stores classified ways as in-area runs, with rings and cells", async () => {
    const { result, db } = await build(EXTRACT);
    const rows = db
      .prepare("SELECT class, ring, points FROM ways ORDER BY id")
      .all() as Array<{ class: string; ring: number; points: Uint8Array }>;
    expect(rows.map((r) => [r.class, r.ring, r.points.length / 16])).toEqual([
      ["path", 0, 2],
      ["green_edge", 1, 5],
      ["green_edge", 0, 5],
      ["green_edge", 0, 2],
    ]);
    expect(result.ways).toBe(4);
    const cells = db.prepare("SELECT count(*) AS n FROM way_cells").get() as {
      n: number;
    };
    expect(cells.n).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it("merges crossing nodes into stops inside the area", async () => {
    const { result, db } = await build(EXTRACT);
    const stops = db
      .prepare("SELECT stop_id, signal FROM stop_nodes ORDER BY lng")
      .all() as Array<{ stop_id: number; signal: number }>;
    expect(stops).toHaveLength(3);
    expect(stops[0]!.stop_id).toBe(stops[1]!.stop_id);
    expect(stops.map((s) => s.signal)).toEqual([1, 1, 0]);
    expect(result.stops).toBe(2);
    db.close();
  });

  it("writes the meta rows", async () => {
    const { result, db } = await build(EXTRACT);
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key, value FROM meta").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((r) => [r.key, r.value]),
    );
    expect(meta).toEqual({
      schema_version: "1",
      area: areaKey(AREA),
      coverage: areaKey(AREA),
      source_url: SOURCE.url,
      etag: SOURCE.etag,
      last_modified: SOURCE.last_modified,
      data_date: "2026-11-01T00:00:00.000Z",
      built_at: "2026-11-08T00:00:00.000Z",
      checked_at: "2026-11-08T00:00:00.000Z",
    });
    expect(result.data_date).toBe("2026-11-01T00:00:00.000Z");
    db.close();
  });

  it("falls back to Last-Modified for the data date", async () => {
    const { result, db } = await build({
      ...EXTRACT,
      replicationTimestamp: undefined,
    });
    expect(result.data_date).toBe("2026-10-31T16:21:44.000Z");
    db.close();
  });

  it("refuses an extract whose nodes are not sorted by id", async () => {
    await expect(
      build({
        nodes: [
          { id: 2, ...at(0, 0) },
          { id: 1, ...at(1, 0) },
        ],
      }),
    ).rejects.toThrow(/not sorted by id/);
  });

  it("keeps only the part of the area the header's bbox covers", async () => {
    const west = at(150, 0).lon;
    const { result, db } = await build({
      bbox: { south: AREA.south, west, north: AREA.north, east: AREA.east + 1 },
      nodes: [
        { id: 1, ...at(0, 0) },
        { id: 2, ...at(100, 0) },
        { id: 3, ...at(200, 0) },
        { id: 4, ...at(300, 0) },
        { id: 5, ...at(250, 0), tags: { highway: "crossing" } },
        { id: 6, ...at(50, 0), tags: { highway: "crossing" } },
      ],
      ways: [{ id: 100, refs: [1, 2, 3, 4], tags: { highway: "footway" } }],
    });
    const coverage = { ...AREA, west };
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key, value FROM meta").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((r) => [r.key, r.value]),
    );
    expect(meta.area).toBe(areaKey(AREA));
    expect(meta.coverage).toBe(areaKey(coverage));
    expect(areaKey(result.coverage)).toBe(areaKey(coverage));
    const way = db.prepare("SELECT points FROM ways").get() as {
      points: Uint8Array;
    };
    expect(way.points.length / 16).toBe(2);
    expect(
      (
        db.prepare("SELECT count(*) AS n FROM stop_nodes").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    db.close();
  });

  it("refuses an extract with no node within the area", async () => {
    await expect(build({ nodes: [{ id: 1, ...far }] })).rejects.toThrow(
      "The extract has no data within 25 km of HOME_START",
    );
    await expect(build({})).rejects.toThrow(/no data within 25 km/);
  });
});
