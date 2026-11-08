import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendVersion,
  CorridorNotFoundError,
  createRoute,
  deleteCorridor,
  isRouteId,
  latestVersion,
  listCorridors,
  makeRouteId,
  RouteNotFoundError,
  RouteVersionConflictError,
  readRoute,
  routeStoreInfo,
  type StoredSegment,
  sweepRoutes,
  updateCorridor,
  versionSegments,
} from "./routeStore";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "route-store-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("ROUTE_RETENTION_DAYS", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function segment(id: string, lat = -33.86): StoredSegment {
  return {
    id,
    kind: "generated",
    label: `Section ${id}`,
    source: { type: "ors", purpose: "route" },
    track: {
      coordinates: [
        [lat, 151.1712345678],
        [lat, 151.18],
      ],
      distance: [0, 924.123456],
      altitude: [10.04, null],
    },
    climb_m: 0,
    climb_source: "elevation_model",
    path_share: 0.5,
    vias: [],
    flexible: false,
    notes: [],
  };
}

async function newRoute(routeId = makeRouteId("draft", "test")) {
  return createRoute({
    route_id: routeId,
    name: "Test",
    kind: "draft",
    next_id: 3,
    segments: [segment("g1"), segment("g2")],
    change: "Stitched",
    warnings: [],
  });
}

describe("route ids", () => {
  it("makes the same id from the same key, and a random one without", () => {
    expect(makeRouteId("draft", "a")).toBe(makeRouteId("draft", "a"));
    expect(makeRouteId("draft", "a")).not.toBe(makeRouteId("draft", "b"));
    expect(makeRouteId("draft")).not.toBe(makeRouteId("draft"));
    expect(makeRouteId("suggestion", "a")).toMatch(/^s[a-z2-7]{10}$/);
  });

  it("refuses anything that could leave the store directory", async () => {
    expect(isRouteId("../../etc")).toBe(false);
    expect(isRouteId("r123")).toBe(false);
    await expect(readRoute("../escape")).resolves.toBeNull();
  });
});

describe("createRoute", () => {
  it("stores version 1 with rounded tracks", async () => {
    const { route, created } = await newRoute();
    expect(created).toBe(true);
    const read = await readRoute(route.route_id);
    expect(read?.versions).toHaveLength(1);
    expect(read?.versions[0]).toMatchObject({
      version: 1,
      parent: null,
      segment_ids: ["g1", "g2"],
    });
    const g1 = read!.segments.g1!;
    expect(g1.track.coordinates[0]).toEqual([-33.86, 151.171235]);
    expect(g1.track.distance[1]).toBe(924.1);
    expect(g1.track.altitude).toEqual([10, null]);
  });

  it("returns the stored route for the same id without writing again", async () => {
    const first = await newRoute();
    const again = await createRoute({
      route_id: first.route.route_id,
      name: "Other",
      kind: "draft",
      next_id: 9,
      segments: [segment("g7")],
      change: "Other",
      warnings: [],
    });
    expect(again.created).toBe(false);
    expect(again.route.name).toBe("Test");
  });

  it("leaves no temporary file", async () => {
    await newRoute();
    const names = await readdir(join(dir, "routes"));
    expect(names.every((n) => n.endsWith(".json"))).toBe(true);
  });
});

describe("appendVersion", () => {
  it("adds a version that shares unchanged segments", async () => {
    const { route } = await newRoute();
    const { version } = await appendVersion(route.route_id, 1, async (r) => ({
      segments: [r.segments.g1!, segment("g3", -33.87)],
      next_id: 4,
      change: "Changed the second section",
      warnings: [],
    }));
    expect(version).toMatchObject({
      version: 2,
      parent: 1,
      segment_ids: ["g1", "g3"],
    });
    const read = (await readRoute(route.route_id))!;
    expect(Object.keys(read.segments).sort()).toEqual(["g1", "g2", "g3"]);
    expect(read.next_id).toBe(4);
    expect(latestVersion(read).version).toBe(2);
    expect(versionSegments(read, read.versions[0]!).map((s) => s.id)).toEqual([
      "g1",
      "g2",
    ]);
  });

  it("refuses a change made from a version that is not the latest", async () => {
    const { route } = await newRoute();
    const build = async () => ({
      segments: [segment("g9")],
      next_id: 10,
      change: "x",
      warnings: [],
    });
    await appendVersion(route.route_id, 1, build);
    const refused = appendVersion(route.route_id, 1, build);
    await expect(refused).rejects.toBeInstanceOf(RouteVersionConflictError);
    await expect(refused).rejects.toThrow(/version 2 is/);
  });

  it("runs two changes to one route one after the other", async () => {
    const { route } = await newRoute();
    const build = async () => ({
      segments: [segment("g9")],
      next_id: 10,
      change: "x",
      warnings: [],
    });
    const results = await Promise.allSettled([
      appendVersion(route.route_id, 1, build),
      appendVersion(route.route_id, 1, build),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await readRoute(route.route_id))!.versions).toHaveLength(2);
  });

  it("stores nothing when the build fails", async () => {
    const { route } = await newRoute();
    await expect(
      appendVersion(route.route_id, 1, async () => {
        throw new Error("no route");
      }),
    ).rejects.toThrow("no route");
    expect((await readRoute(route.route_id))!.versions).toHaveLength(1);
  });

  it("reports a route that is not stored", async () => {
    await expect(
      appendVersion(makeRouteId("draft", "missing"), 1, async () => {
        throw new Error("unreachable");
      }),
    ).rejects.toBeInstanceOf(RouteNotFoundError);
  });
});

describe("routeStoreInfo", () => {
  it("names the directory and counts only route files", async () => {
    expect(await routeStoreInfo()).toMatchObject({ dir, routes: 0 });
    await newRoute();
    await writeFile(join(dir, "routes", "notes.json"), "{}");
    expect(await routeStoreInfo()).toMatchObject({ dir, routes: 1 });
  });
});

describe("sweepRoutes", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function age(routeId: string, days: number) {
    const when = new Date(Date.now() - days * DAY);
    await utimes(join(dir, "routes", `${routeId}.json`), when, when);
  }

  it("deletes drafts unused for the retention period", async () => {
    const kept = (await newRoute(makeRouteId("draft", "kept"))).route.route_id;
    const old = (await newRoute(makeRouteId("draft", "old"))).route.route_id;
    await age(kept, 29);
    await age(old, 31);
    expect(await sweepRoutes()).toBe(1);
    expect(await readRoute(kept)).not.toBeNull();
    expect(await readRoute(old)).toBeNull();
  });

  it("reads ROUTE_RETENTION_DAYS", async () => {
    vi.stubEnv("ROUTE_RETENTION_DAYS", "7");
    const old = (await newRoute()).route.route_id;
    await age(old, 8);
    expect(await sweepRoutes()).toBe(1);
  });

  it("keeps suggested routes for 3 days", async () => {
    const id = makeRouteId("suggestion", "s");
    await newRoute(id);
    await age(id, 4);
    expect(await sweepRoutes()).toBe(1);
  });

  it("counts a read as a use", async () => {
    const id = (await newRoute()).route.route_id;
    await age(id, 31);
    await readRoute(id);
    expect(await sweepRoutes()).toBe(0);
  });

  it("deletes a stale temporary file and ignores files that are not routes", async () => {
    await newRoute();
    const temp = join(dir, "routes", "rabcdefghij.json.1.ab.tmp");
    await writeFile(temp, "{");
    const old = new Date(Date.now() - 2 * DAY);
    await utimes(temp, old, old);
    await writeFile(join(dir, "routes", "notes.txt"), "keep");
    expect(await sweepRoutes()).toBe(0);
    const names = await readdir(join(dir, "routes"));
    expect(names).toContain("notes.txt");
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("finds nothing to sweep before any route is stored", async () => {
    expect(await sweepRoutes()).toBe(0);
  });
});

describe("corridors", () => {
  async function corridor(key: string, name: string, one_way?: boolean) {
    return createRoute({
      route_id: makeRouteId("corridor", key),
      name,
      kind: "corridor",
      ...(one_way === undefined ? {} : { one_way }),
      next_id: 2,
      segments: [segment("g1")],
      change: "Saved as corridor",
      warnings: [],
    });
  }

  it("gives corridor ids the c prefix", () => {
    const id = makeRouteId("corridor", "x");
    expect(id).toMatch(/^c[a-z2-7]{10}$/);
    expect(isRouteId(id)).toBe(true);
  });

  it("never sweeps a corridor", async () => {
    const { route } = await corridor("a", "Bay Run");
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, "routes", `${route.route_id}.json`), old, old);
    expect(await sweepRoutes()).toBe(0);
    expect(await readRoute(route.route_id)).not.toBeNull();
  });

  it("lists corridors by name and skips other routes", async () => {
    await corridor("b", "Glebe foreshore");
    await corridor("a", "Bay Run", true);
    await createRoute({
      route_id: makeRouteId("draft", "d"),
      name: "Draft",
      kind: "draft",
      next_id: 2,
      segments: [segment("g1")],
      change: "x",
      warnings: [],
    });
    const list = await listCorridors();
    expect(list.map((c) => [c.name, c.one_way])).toEqual([
      ["Bay Run", true],
      ["Glebe foreshore", undefined],
    ]);
  });

  it("lists nothing when no route was ever stored", async () => {
    expect(await listCorridors()).toEqual([]);
  });

  it("renames and sets one-way without a new version", async () => {
    const { route } = await corridor("a", "Bay Run");
    const updated = await updateCorridor(route.route_id, {
      name: "The Bay Run",
      one_way: true,
    });
    expect(updated.name).toBe("The Bay Run");
    expect(updated.one_way).toBe(true);
    expect(updated.versions).toEqual(route.versions);
    expect((await readRoute(route.route_id))?.name).toBe("The Bay Run");
  });

  it("deletes a corridor and refuses other ids", async () => {
    const { route } = await corridor("a", "Bay Run");
    await deleteCorridor(route.route_id);
    expect(await readRoute(route.route_id)).toBeNull();
    await expect(deleteCorridor(route.route_id)).rejects.toBeInstanceOf(
      CorridorNotFoundError,
    );
    const { route: draft } = await createRoute({
      route_id: makeRouteId("draft", "d"),
      name: "Draft",
      kind: "draft",
      next_id: 2,
      segments: [segment("g1")],
      change: "x",
      warnings: [],
    });
    await expect(deleteCorridor(draft.route_id)).rejects.toBeInstanceOf(
      CorridorNotFoundError,
    );
    await expect(
      updateCorridor(draft.route_id, { name: "x" }),
    ).rejects.toBeInstanceOf(CorridorNotFoundError);
  });
});
