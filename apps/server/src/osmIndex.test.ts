import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FixtureExtract,
  type FixtureNode,
  osmPbfBytes,
} from "./__fixtures__/osmPbf";
import { type LatLng, type RouteTrack } from "./mapAnchors";
import {
  areaAround,
  closeOsmIndex,
  osmIndexDir,
  osmIndexInfo,
  osmIndexPath,
  parkReach,
  placeNear,
  routeOsmStats,
} from "./osmIndex";
import { buildOsmIndex } from "./osmIndexBuild";

const HOME: LatLng = [-33.87, 151.2];
const KX = 111_320 * Math.cos((HOME[0] * Math.PI) / 180);
/** A point `x` m east and `y` m north of HOME. */
const pt = (x: number, y: number): LatLng => [
  HOME[0] + y / 110_540,
  HOME[1] + x / KX,
];

let dir: string;
let nextId = 1;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "osm-index-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("HOME_START", `${HOME[0]},${HOME[1]}`);
  vi.stubEnv("OSM_EXTRACT_URL", "https://example.org/x.osm.pbf");
  closeOsmIndex();
  nextId = 1;
});
afterEach(async () => {
  closeOsmIndex();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A track along the given points, in metres from HOME. */
function track(...xy: Array<[number, number]>): RouteTrack {
  const coordinates = xy.map(([x, y]) => pt(x, y));
  const distance = [0];
  for (let i = 1; i < xy.length; i++)
    distance.push(
      distance[i - 1]! +
        Math.hypot(xy[i]![0] - xy[i - 1]![0], xy[i]![1] - xy[i - 1]![1]),
    );
  return { coordinates, distance, altitude: coordinates.map(() => null) };
}

/** Builds the index from ways given as metre polylines with tags, plus tagged nodes. */
async function index(opts: {
  ways?: Array<{
    xy: Array<[number, number]>;
    tags?: Record<string, string>;
    closed?: boolean;
    id?: number;
  }>;
  stops?: Array<{ xy: [number, number]; tags: Record<string, string> }>;
  relations?: FixtureExtract["relations"];
  bbox?: FixtureExtract["bbox"];
}) {
  // An extract with nothing in the area does not build; this one node is the minimum.
  const nodes: FixtureNode[] = [{ id: nextId++, lat: HOME[0], lon: HOME[1] }];
  const ways = (opts.ways ?? []).map((w) => {
    const refs = w.xy.map(([x, y]) => {
      const [lat, lon] = pt(x, y);
      nodes.push({ id: nextId, lat, lon });
      return nextId++;
    });
    if (w.closed) refs.push(refs[0]!);
    return { id: w.id ?? nextId++, refs, tags: w.tags };
  });
  for (const s of opts.stops ?? []) {
    const [lat, lon] = pt(...s.xy);
    nodes.push({ id: nextId++, lat, lon, tags: s.tags });
  }
  await mkdir(osmIndexDir(), { recursive: true });
  const pbf = join(dir, "x.osm.pbf");
  await writeFile(
    pbf,
    osmPbfBytes({
      nodes,
      ways,
      relations: opts.relations,
      bbox: opts.bbox,
    }),
  );
  await buildOsmIndex(
    pbf,
    osmIndexPath(),
    areaAround(HOME, 25),
    {
      url: "https://example.org/x.osm.pbf",
      etag: "",
      last_modified: "",
    },
    Date.parse("2026-11-01T00:00:00Z"),
  );
  closeOsmIndex();
}

const ALONG = track([0, 0], [1000, 0]);

describe("routeOsmStats", () => {
  it("counts a path beside the track, same heading", async () => {
    await index({
      ways: [
        {
          xy: [
            [-50, 5],
            [1050, 5],
          ],
          tags: { highway: "footway" },
        },
      ],
    });
    expect(routeOsmStats(ALONG)).toEqual({
      crossings_per_km: 0,
      signals_per_km: 0,
      path_share: 1,
      main_road_km: 0,
      green_share: 0,
    });
  });

  it("does not count a sidewalk, a path 40 m away or a path across", async () => {
    await index({
      ways: [
        {
          xy: [
            [-50, 5],
            [1050, 5],
          ],
          tags: { highway: "footway", footway: "sidewalk" },
        },
        {
          xy: [
            [-50, 40],
            [1050, 40],
          ],
          tags: { highway: "footway" },
        },
        {
          xy: [
            [500, -500],
            [500, 500],
          ],
          tags: { highway: "footway" },
        },
      ],
    });
    expect(routeOsmStats(ALONG)!.path_share).toBe(0);
  });

  it("counts a shared path beside a main road as both", async () => {
    await index({
      ways: [
        {
          xy: [
            [-50, 0],
            [1050, 0],
          ],
          tags: { highway: "primary" },
        },
        {
          xy: [
            [-50, 12],
            [1050, 12],
          ],
          tags: { highway: "cycleway", foot: "designated" },
        },
      ],
    });
    const stats = routeOsmStats(track([0, 12], [1000, 12]))!;
    expect(stats.path_share).toBe(1);
    expect(stats.main_road_km).toBe(1);
  });

  it("counts a junction's signal and crossing once, and another crossing", async () => {
    await index({
      stops: [
        { xy: [500, 3], tags: { highway: "traffic_signals" } },
        {
          xy: [511, -3],
          tags: { highway: "crossing", crossing: "traffic_signals" },
        },
        { xy: [800, 2], tags: { highway: "crossing" } },
        { xy: [300, 60], tags: { highway: "crossing" } },
      ],
    });
    const stats = routeOsmStats(ALONG)!;
    expect(stats.crossings_per_km).toBe(2);
    expect(stats.signals_per_km).toBe(1);
  });

  it("counts a stop once per pass, so an out-and-back keeps its leg's rate", async () => {
    await index({
      stops: [
        { xy: [200, 2], tags: { highway: "crossing" } },
        // At the turn: reached once.
        { xy: [497, 2], tags: { highway: "traffic_signals" } },
      ],
    });
    const leg = routeOsmStats(track([0, 0], [500, 0]))!;
    const outAndBack = routeOsmStats(track([0, 0], [500, 0], [0, 0]))!;
    expect(leg.crossings_per_km).toBe(4);
    expect(outAndBack.crossings_per_km).toBe(3);
    expect(outAndBack.signals_per_km).toBe(1);
  });

  it("counts inside a park and near water as green", async () => {
    await index({
      ways: [
        {
          xy: [
            [-200, -300],
            [1200, -300],
            [1200, 300],
            [-200, 300],
          ],
          closed: true,
          tags: { leisure: "park" },
        },
        {
          id: 9000,
          xy: [
            [-50, 1030],
            [1050, 1030],
          ],
        },
      ],
      relations: [
        {
          id: 1,
          tags: { type: "multipolygon", natural: "water" },
          members: [{ type: "way", ref: 9000, role: "outer" }],
        },
      ],
    });
    expect(routeOsmStats(ALONG)!.green_share).toBe(1);
    expect(routeOsmStats(track([0, 400], [1000, 400]))!.green_share).toBe(0);
    expect(routeOsmStats(track([0, 1000], [1000, 1000]))!.green_share).toBe(1);
  });

  it("is null outside the area, for a tiny track, and with no index", async () => {
    expect(routeOsmStats(ALONG)).toBeNull();
    await index({});
    expect(routeOsmStats(track([0, 0], [30_000, 0]))).toBeNull();
    expect(routeOsmStats(track([0, 0], [3, 0]))).toBeNull();
    expect(routeOsmStats(ALONG)).not.toBeNull();
  });
});

describe("placeNear", () => {
  const SQUARE: Array<[number, number]> = [
    [0, 0],
    [400, 0],
    [400, 400],
    [0, 400],
  ];
  const way = (
    name: string,
    y: number,
    highway: string,
    extra: Record<string, string> = {},
  ) => ({
    xy: [
      [1000, y],
      [1400, y],
    ] as Array<[number, number]>,
    tags: { highway, name, ...extra },
  });

  it("names the park inside, else the nearest named way within 60 m, else null", async () => {
    await index({
      ways: [
        {
          xy: SQUARE,
          closed: true,
          tags: { leisure: "park", name: "Jubilee Park" },
        },
        way("Glebe Path", 0, "footway"),
        way("Bridge Road", 40, "residential"),
        way("Western Distributor", 10, "motorway"),
        way("Private Lane", 5, "service", { foot: "private" }),
        {
          xy: [
            [1000, -20],
            [1400, -20],
          ],
          tags: { highway: "residential" },
        },
      ],
    });
    expect(placeNear(pt(200, 200))).toBe("Jubilee Park");
    expect(placeNear(pt(200, -40))).toBe("Jubilee Park");
    expect(placeNear(pt(1200, 12))).toBe("Glebe Path");
    expect(placeNear(pt(1200, 30))).toBe("Bridge Road");
    expect(placeNear(pt(1200, 200))).toBeNull();
    expect(placeNear(pt(1200, 800))).toBeNull();
  });

  it("is null outside the index and with no index", async () => {
    expect(placeNear(pt(0, 0))).toBeNull();
    await index({ ways: [way("Glebe Path", 0, "footway")] });
    expect(placeNear([HOME[0] + 1, HOME[1]])).toBeNull();
  });
});

describe("parkReach", () => {
  // A 400 m square park whose looked-up point sits near its south edge.
  const SQUARE: Array<[number, number]> = [
    [0, 0],
    [400, 0],
    [400, 400],
    [0, 400],
  ];
  const POINT = pt(200, 30);

  it("reaches inside a named park and within the radius of its edge", async () => {
    await index({
      ways: [
        {
          xy: SQUARE,
          closed: true,
          tags: { leisure: "park", name: "Jubilee Park" },
        },
      ],
    });
    const reaches = parkReach(POINT, "jubilee park", 100)!;
    expect(reaches(pt(200, 200))).toBe(true);
    expect(reaches(pt(200, 480))).toBe(true);
    expect(reaches(pt(200, 520))).toBe(false);
    expect(reaches(pt(-90, 200))).toBe(true);
    expect(parkReach(POINT, "Wentworth Park", 100)).toBeNull();
    // A looked-up point just outside the park still names it; far outside does not.
    expect(parkReach(pt(200, -60), "Jubilee Park", 100)?.(pt(200, 480))).toBe(
      true,
    );
    expect(parkReach(pt(600, 30), "Jubilee Park", 100)).toBeNull();
  });

  it("joins a multipolygon's outer ways in any order", async () => {
    await index({
      ways: [
        { id: 9001, xy: [SQUARE[2]!, SQUARE[3]!, SQUARE[0]!] },
        { id: 9002, xy: [SQUARE[0]!, SQUARE[1]!, SQUARE[2]!] },
      ],
      relations: [
        {
          id: 700,
          tags: { type: "multipolygon", leisure: "park", name: "Jubilee Park" },
          members: [
            { type: "way", ref: 9001, role: "outer" },
            { type: "way", ref: 9002, role: "outer" },
          ],
        },
      ],
    });
    expect(parkReach(POINT, "Jubilee Park", 100)?.(pt(200, 480))).toBe(true);
  });

  it("has no outline for a park missing a way or cut by the area edge", async () => {
    await index({
      ways: [
        { id: 9001, xy: [SQUARE[2]!, SQUARE[3]!, SQUARE[0]!] },
        { id: 9002, xy: [SQUARE[0]!, [30_000, 0], SQUARE[2]!] },
      ],
      relations: [
        {
          id: 700,
          tags: { type: "multipolygon", leisure: "park", name: "Cut Park" },
          members: [
            { type: "way", ref: 9001, role: "outer" },
            { type: "way", ref: 9002, role: "outer" },
          ],
        },
        {
          id: 701,
          tags: { type: "multipolygon", leisure: "park", name: "Gone Park" },
          members: [
            { type: "way", ref: 9001, role: "outer" },
            { type: "way", ref: 9999, role: "outer" },
          ],
        },
      ],
    });
    expect(parkReach(POINT, "Cut Park", 100)).toBeNull();
    expect(parkReach(POINT, "Gone Park", 100)).toBeNull();
  });

  it("is null without an index", () => {
    expect(parkReach(POINT, "Jubilee Park", 100)).toBeNull();
  });
});

describe("coverage", () => {
  it("is null for a track leaving the part the extract covers", async () => {
    const area = areaAround(HOME, 25);
    await index({
      bbox: { ...area, west: pt(500, 0)[1], east: area.east + 1 },
    });
    expect(routeOsmStats(track([0, 0], [1000, 0]))).toBeNull();
    expect(routeOsmStats(track([600, 0], [1000, 0]))).not.toBeNull();
  });
});

describe("the settings gate", () => {
  it("stops serving a leftover index once a setting is unset", async () => {
    await index({});
    expect(routeOsmStats(ALONG)).not.toBeNull();
    vi.stubEnv("OSM_EXTRACT_URL", "");
    expect(routeOsmStats(ALONG)).toBeNull();
    vi.stubEnv("OSM_EXTRACT_URL", "https://example.org/x.osm.pbf");
    vi.stubEnv("HOME_START", "");
    expect(routeOsmStats(ALONG)).toBeNull();
    vi.stubEnv("HOME_START", `${HOME[0]},${HOME[1]}`);
    expect(routeOsmStats(ALONG)).not.toBeNull();
  });
});

describe("a missing index", () => {
  it("is not read when its schema version differs", async () => {
    await index({});
    const db = new DatabaseSync(osmIndexPath());
    db.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    db.close();
    closeOsmIndex();
    expect(routeOsmStats(ALONG)).toBeNull();
    expect(osmIndexInfo()).toEqual({ state: "missing" });
  });

  it("is seen once built, without closeOsmIndex", async () => {
    expect(routeOsmStats(ALONG)).toBeNull();
    const pbf = join(dir, "y.osm.pbf");
    await writeFile(
      pbf,
      osmPbfBytes({ nodes: [{ id: 1, lat: HOME[0], lon: HOME[1] }] }),
    );
    await mkdir(osmIndexDir(), { recursive: true });
    await buildOsmIndex(
      pbf,
      osmIndexPath(),
      areaAround(HOME, 25),
      { url: "https://example.org/x.osm.pbf", etag: "", last_modified: "" },
      Date.parse("2026-11-01T00:00:00Z"),
    );
    expect(routeOsmStats(ALONG)).not.toBeNull();
  });
});

describe("osmIndexInfo", () => {
  it("is unconfigured without OSM_EXTRACT_URL or HOME_START", () => {
    vi.stubEnv("OSM_EXTRACT_URL", "");
    expect(osmIndexInfo()).toEqual({ state: "unconfigured" });
    vi.stubEnv("OSM_EXTRACT_URL", "https://example.org/x.osm.pbf");
    vi.stubEnv("HOME_START", "");
    expect(osmIndexInfo()).toEqual({ state: "unconfigured" });
  });

  it("is missing before the first build, then ready with its age", async () => {
    expect(osmIndexInfo()).toEqual({ state: "missing" });
    await index({});
    expect(osmIndexInfo(Date.parse("2026-11-04T12:00:00Z"))).toEqual({
      state: "ready",
      data_date: "2026-11-01T00:00:00.000Z",
      age_days: 3,
    });
  });
});
