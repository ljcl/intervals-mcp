import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}) {
  const nodes: FixtureNode[] = [];
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
  await writeFile(pbf, osmPbfBytes({ nodes, ways, relations: opts.relations }));
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

describe("a missing index", () => {
  it("is seen once built, without closeOsmIndex", async () => {
    expect(routeOsmStats(ALONG)).toBeNull();
    const pbf = join(dir, "y.osm.pbf");
    await writeFile(pbf, osmPbfBytes({ nodes: [], ways: [] }));
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
