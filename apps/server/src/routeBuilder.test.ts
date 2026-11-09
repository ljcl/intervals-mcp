import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeGeocode,
  fakeOrsRoute,
  PLACES,
  SUNDAY_ACTIVITY,
  SUNDAY_ID,
  sundayPointAt,
  sundayStreams,
} from "./__fixtures__/sundayRoute";
import { haversineMeters } from "./mapAnchors";
import * as ors from "./orsClient";
import * as osmIndex from "./osmIndex";
import { routeOsmStats } from "./osmIndex";
import {
  addCorridor,
  amendRoute,
  type BuildEnv,
  compareVersions,
  layoutSegments,
  loadRouteVersion,
  RouteBuildError,
  type SegmentInput,
  stitchRoute,
  storeSuggestedRoute,
  summarizeRoute,
  versionTrack,
} from "./routeBuilder";
import {
  concatTracks,
  moveToward,
  trackDiff,
  trackLength,
} from "./routeGeometry";
import {
  deleteCorridor,
  findVersion,
  readRoute,
  versionSegments,
} from "./routeStore";

vi.mock("./orsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orsClient")>();
  return {
    ...actual,
    orsRoute: vi.fn(),
    geocode: vi.fn(),
  };
});

vi.mock("./osmIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./osmIndex")>()),
  routeOsmStats: vi.fn(),
}));

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(async () => structuredClone(SUNDAY_ACTIVITY)),
    getActivityStreams: vi.fn(async () => sundayStreams()),
  };
});

const ENV: BuildEnv = { orsKey: "test-ors-key", homeStart: null };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "route-builder-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.mocked(ors.orsRoute).mockImplementation(async (key, request) =>
    fakeOrsRoute(key, request),
  );
  vi.mocked(ors.geocode).mockImplementation(async (key, text) =>
    fakeGeocode(key, text),
  );
  vi.mocked(routeOsmStats).mockReset().mockReturnValue(null);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The acceptance stitch: km 0-5.27, a 1 km out-and-back toward Iron Cove, km 5.27-12.03. */
const SUNDAY_STITCH: SegmentInput[] = [
  { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 5.27 },
  {
    type: "out_and_back",
    toward: "Iron Cove, Sydney",
    distance_km: 1,
    flexible: true,
  },
  { type: "activity", id: SUNDAY_ID, from_km: 5.27, to_km: 12.03 },
];

async function stitchSunday() {
  return stitchRoute(
    "key",
    { name: "Sunday + Iron Cove", segments: SUNDAY_STITCH },
    ENV,
  );
}

/** The largest gap between one section's end and the next one's start. */
function widestSeam(routeId: string, version: number) {
  return readRoute(routeId).then((route) => {
    const segments = versionSegments(route!, findVersion(route!, version)!);
    let widest = 0;
    for (let i = 1; i < segments.length; i++)
      widest = Math.max(
        widest,
        haversineMeters(
          segments[i - 1]!.track.coordinates.at(-1)!,
          segments[i]!.track.coordinates[0]!,
        ),
      );
    return widest;
  });
}

describe("stitchRoute", () => {
  it("joins a past run, an out-and-back and the rest of the run into one route", async () => {
    const built = await stitchSunday();
    const summary = summarizeRoute(built.route, built.version);
    expect(built.created).toBe(true);
    expect(built.version.version).toBe(1);
    expect(built.ors_calls).toBe(1);
    // 5.27 + 1 + 6.76 km, give or take the recording.
    expect(summary.distance_m / 1000).toBeCloseTo(13.03, 1);
    expect(summary.segments.map((s) => s.kind)).toEqual([
      "activity",
      "out_and_back",
      "activity",
    ]);
    expect(await widestSeam(built.route.route_id, 1)).toBeLessThanOrEqual(30);
    const [first, oab, last] = summary.segments;
    expect(first!.source).toEqual({
      type: "activity",
      activity_id: SUNDAY_ID,
      from_km: 0,
      to_km: 5.27,
    });
    expect(first!.climb_source).toBe("recorded");
    expect(first!.path_share).toBeNull();
    expect(oab!.distance_m).toBeCloseTo(1000, -1);
    expect(oab!.climb_source).toBe("elevation_model");
    expect(oab!.path_share).toBe(0.6);
    expect(oab!.flexible).toBe(true);
    expect(oab!.vias).toEqual([
      expect.objectContaining({ kind: "turnaround", km: expect.any(Number) }),
    ]);
    // The recorded climb (30 m from km 7.8 to 9) stays with its section.
    // Less up to 3 m of hysteresis (trackClimb).
    expect(last!.climb_m).toBeGreaterThanOrEqual(27);
    expect(last!.climb_m).toBeLessThanOrEqual(31);
    expect(summary.path_share).toBe(0.6);
    expect(summary.path_share_coverage).toBeLessThan(0.1);
    expect(summary.crossings_per_km).toBeNull();
  });

  it("takes the whole route's path share from the OpenStreetMap index when it covers the route", async () => {
    const built = await stitchSunday();
    vi.mocked(routeOsmStats).mockReturnValue({
      crossings_per_km: 2.4,
      signals_per_km: 0.8,
      path_share: 0.31,
      main_road_km: 0.6,
      green_share: 0.55,
    });
    const summary = summarizeRoute(built.route, built.version);
    expect(routeOsmStats).toHaveBeenCalledWith(
      versionTrack(built.route, built.version),
    );
    expect(summary).toMatchObject({
      path_share: 0.31,
      path_share_coverage: 1,
      crossings_per_km: 2.4,
      signals_per_km: 0.8,
      main_road_km: 0.6,
      green_share: 0.55,
    });
    // Sections keep the share they were stored with.
    expect(summary.segments.map((s) => s.path_share)).toEqual([
      null,
      0.6,
      null,
    ]);
  });

  it("returns the stored route for the same request without routing again", async () => {
    const first = await stitchSunday();
    vi.mocked(ors.orsRoute).mockClear();
    const again = await stitchSunday();
    expect(again.created).toBe(false);
    expect(again.route.route_id).toBe(first.route.route_id);
    expect(ors.orsRoute).not.toHaveBeenCalled();
  });

  it("routes a gap wider than 30 m as a join", async () => {
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 2 },
          { type: "activity", id: SUNDAY_ID, from_km: 2.5, to_km: 4 },
        ],
      },
      ENV,
    );
    const summary = summarizeRoute(built.route, built.version);
    expect(summary.segments.map((s) => s.kind)).toEqual([
      "activity",
      "join",
      "activity",
    ]);
    expect(summary.segments[1]!.distance_m).toBeCloseTo(500, -1);
    expect(await widestSeam(built.route.route_id, 1)).toBeLessThanOrEqual(30);
  });

  it("joins ends within 30 m directly", async () => {
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 2 },
          { type: "activity", id: SUNDAY_ID, from_km: 2.02, to_km: 4 },
        ],
      },
      ENV,
    );
    expect(built.ors_calls).toBe(0);
    expect(built.version.segment_ids).toHaveLength(2);
  });

  it("names where a gap that cannot be routed is", async () => {
    vi.mocked(ors.orsRoute).mockRejectedValueOnce(
      new ors.OrsApiError("x", { status: 404, statusText: "", data: "" }),
    );
    const stitched = stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 2 },
          { type: "activity", id: SUNDAY_ID, from_km: 2.5, to_km: 4 },
        ],
      },
      ENV,
    );
    await expect(stitched).rejects.toBeInstanceOf(RouteBuildError);
    await expect(stitched).rejects.toThrow(
      /The 50\d m gap between "Sunday long run km 0\.00-2\.00" and "Sunday long run km 2\.50-4\.00" at km 2\.00 \(from -33\.\d{3},151\.\d{3} to -33\.\d{3},151\.\d{3}\) could not be routed: OpenRouteService found no walkable path/,
    );
    // Nothing was stored.
    expect(await readdir(join(dir, "routes")).catch(() => [])).toEqual([]);
  });

  it("runs a past run backwards when from_km is above to_km", async () => {
    const built = await stitchRoute(
      "key",
      { segments: [{ type: "activity", id: SUNDAY_ID, from_km: 3, to_km: 1 }] },
      ENV,
    );
    const track = versionTrack(built.route, built.version);
    expect(
      haversineMeters(track.coordinates[0]!, sundayPointAt(3)),
    ).toBeLessThan(5);
    expect(trackLength(track)).toBeCloseTo(2000, -1);
    expect(summarizeRoute(built.route, built.version).segments[0]!.label).toBe(
      "Sunday long run km 3.00-1.00",
    );
  });

  it("routes a generated section between its neighbours, and a last one back to the start", async () => {
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 4 },
          { type: "generated", via: ["Callan Park, Sydney"] },
        ],
      },
      ENV,
    );
    const track = versionTrack(built.route, built.version);
    expect(
      haversineMeters(track.coordinates.at(-1)!, track.coordinates[0]!),
    ).toBeLessThan(1);
    const summary = summarizeRoute(built.route, built.version);
    expect(summary.segments[1]!.vias[0]!.label).toBe("Callan Park, Sydney");
  });

  it("takes part of a stored route, each section keeping its source", async () => {
    const sunday = await stitchSunday();
    const built = await stitchRoute(
      "key",
      {
        segments: [
          {
            type: "route",
            route_id: sunday.route.route_id,
            from_km: 4,
            to_km: 7,
          },
        ],
      },
      ENV,
    );
    const summary = summarizeRoute(built.route, built.version);
    expect(summary.distance_m).toBeCloseTo(3000, -1);
    expect(summary.segments.map((s) => s.kind)).toEqual([
      "activity",
      "out_and_back",
      "activity",
    ]);
    expect(summary.segments[0]!.source).toMatchObject({
      from_km: 4,
      to_km: 5.27,
    });
  });

  it("refuses a km past the end of a run", async () => {
    await expect(
      stitchRoute(
        "key",
        {
          segments: [
            { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 20 },
          ],
        },
        ENV,
      ),
    ).rejects.toThrow(/12\.0\d km long, so km 20 is past its end/);
  });

  it("needs ORS_API_KEY to route", async () => {
    await expect(
      stitchRoute(
        "key",
        {
          segments: [
            {
              type: "out_and_back",
              at: "-33.86,151.17",
              toward: "west",
              distance_km: 1,
            },
          ],
        },
        { orsKey: null, homeStart: null },
      ),
    ).rejects.toThrow(/ORS_API_KEY/);
  });

  it("needs a start for a generated section that comes first", async () => {
    await expect(
      stitchRoute(
        "key",
        { segments: [{ type: "generated", end: "-33.86,151.17" }] },
        ENV,
      ),
    ).rejects.toThrow(/needs a start/);
  });
});

describe("amendRoute", () => {
  it("moves the turnaround 200 m west, changing only the out-and-back", async () => {
    const v1 = await stitchSunday();
    const before = summarizeRoute(v1.route, v1.version);
    const turnaround = before.segments[1]!.vias[0]!;
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          {
            op: "move_via",
            via_id: turnaround.id,
            shift: { direction: "west", distance_m: 200 },
          },
        ],
      },
      ENV,
    );
    expect(done.version.version).toBe(2);
    expect(done.ors_calls).toBe(1);
    const [a, , c] = done.version.segment_ids;
    // The two past-run sections are the same stored segments.
    expect(a).toBe(v1.version.segment_ids[0]);
    expect(c).toBe(v1.version.segment_ids[2]);
    const change = compareVersions(done.route, v1.version, done.version);
    expect(change.changed).toBe(true);
    expect(change.distance_change_m).toBeCloseTo(400, -1);
    expect(change.from_km).toBeGreaterThan(5.2);
    expect(change.to_km).toBeLessThan(5.27 + 1.45);
    const after = summarizeRoute(done.route, done.version);
    expect(after.segments[1]!.vias[0]!.id).toBe(turnaround.id);
    expect(after.segments[1]!.label).toBe(before.segments[1]!.label);
    // Version 1 is kept as it was.
    const reread = await loadRouteVersion(v1.route.route_id, 1);
    expect(summarizeRoute(reread.route, reread.version).distance_m).toBe(
      before.distance_m,
    );
  });

  it("restores version 1 as version 3, the same track", async () => {
    const v1 = await stitchSunday();
    const via = summarizeRoute(v1.route, v1.version).segments[1]!.vias[0]!.id;
    await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          {
            op: "move_via",
            via_id: via,
            shift: { direction: "W", distance_m: 200 },
          },
        ],
      },
      ENV,
    );
    const restored = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 2,
        operations: [{ op: "restore", version: 1 }],
      },
      ENV,
    );
    expect(restored.version.version).toBe(3);
    expect(restored.version.change).toBe("Restored version 1");
    expect(restored.version.segment_ids).toEqual(v1.version.segment_ids);
    expect(
      compareVersions(restored.route, v1.version, restored.version).changed,
    ).toBe(false);
    const undone = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 3,
        operations: [{ op: "undo" }],
      },
      ENV,
    );
    expect(undone.version.change).toBe("Restored version 2 (undo)");
  });

  it("refuses a change from a version that is not the latest", async () => {
    const v1 = await stitchSunday();
    await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [{ op: "reverse" }],
      },
      ENV,
    );
    vi.mocked(ors.orsRoute).mockClear();
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [{ op: "trim", from_km: 0, to_km: 1 }],
        },
        ENV,
      ),
    ).rejects.toThrow(/version 2 is/);
    expect(ors.orsRoute).not.toHaveBeenCalled();
  });

  it("inserts a via point by routing at most 1 km either side of it", async () => {
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          { op: "insert_via", km: 1.5, place: "Callan Park, Sydney" },
        ],
      },
      ENV,
    );
    const change = compareVersions(done.route, v1.version, done.version);
    expect(change.old_from_km).toBeGreaterThanOrEqual(0.49);
    expect(change.old_to_km).toBeLessThanOrEqual(2.51);
    const summary = summarizeRoute(done.route, done.version);
    const added = summary.segments
      .flatMap((s) => s.vias)
      .find((v) => v.label === "Callan Park, Sydney");
    expect(added).toBeDefined();
    // Removing it routes that stretch again without it.
    const removed = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 2,
        operations: [{ op: "remove_via", via_id: added!.id }],
      },
      ENV,
    );
    expect(
      summarizeRoute(removed.route, removed.version)
        .segments.flatMap((s) => s.vias)
        .some((v) => v.id === added!.id),
    ).toBe(false);
  });

  it("removes an out-and-back with its turnaround", async () => {
    const v1 = await stitchSunday();
    const via = summarizeRoute(v1.route, v1.version).segments[1]!.vias[0]!.id;
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [{ op: "remove_via", via_id: via }],
      },
      ENV,
    );
    const summary = summarizeRoute(done.route, done.version);
    expect(summary.segments.map((s) => s.kind)).toEqual([
      "activity",
      "activity",
    ]);
    expect(done.ors_calls).toBe(0);
  });

  it("trims a section and reconnects the ends", async () => {
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [{ op: "trim", from_km: 1, to_km: 2 }],
      },
      ENV,
    );
    // The run goes straight from km 1 to km 2, so the routed join is as long.
    const summary = summarizeRoute(done.route, done.version);
    expect(summary.segments.map((s) => s.kind).slice(0, 3)).toEqual([
      "activity",
      "join",
      "activity",
    ]);
    expect(summary.segments[0]!.source).toMatchObject({ from_km: 0, to_km: 1 });
    expect(summary.segments[2]!.source).toMatchObject({ from_km: 2 });
    expect(done.ors_calls).toBe(1);
  });

  it("trims out a section whose ends meet, with no join", async () => {
    const v1 = await stitchSunday();
    const oab = summarizeRoute(v1.route, v1.version).segments[1]!;
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [{ op: "trim", from_km: oab.from_km, to_km: oab.to_km }],
      },
      ENV,
    );
    const change = compareVersions(done.route, v1.version, done.version);
    expect(change.distance_change_m).toBeCloseTo(-oab.distance_m, -1);
    expect(done.ors_calls).toBe(0);
  });

  it("replaces a section with one through a place, and with part of a past run", async () => {
    const v1 = await stitchSunday();
    const through = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          {
            op: "replace_section",
            from_km: 1,
            to_km: 2,
            through: "Callan Park, Sydney",
          },
        ],
      },
      ENV,
    );
    expect(through.version.change).toMatch(/through Callan Park/);
    const activity = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 2,
        operations: [
          {
            op: "replace_section",
            from_km: 9,
            to_km: 10,
            activity: { id: SUNDAY_ID, from_km: 9, to_km: 10 },
          },
        ],
      },
      ENV,
    );
    const kinds = summarizeRoute(activity.route, activity.version).segments.map(
      (s) => s.kind,
    );
    expect(kinds.filter((k) => k === "activity").length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it("adds an out-and-back toward a compass direction", async () => {
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          { op: "add_out_and_back", km: 3, toward: "south", distance_km: 0.8 },
        ],
      },
      ENV,
    );
    const change = compareVersions(done.route, v1.version, done.version);
    expect(change.distance_change_m).toBeCloseTo(800, -1);
    expect(change.old_from_km).toBeCloseTo(3, 1);
  });

  it("fits a flexible out-and-back to make the route a target distance", async () => {
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [{ op: "fit_distance", target_km: 14 }],
      },
      ENV,
    );
    const summary = summarizeRoute(done.route, done.version);
    expect(summary.distance_m / 1000).toBeCloseTo(14, 1);
    expect(summary.segments[1]!.kind).toBe("out_and_back");
    expect(summary.segments[1]!.flexible).toBe(true);
  });

  it("fits a section by stretching it when it is routed", async () => {
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          { op: "fit_distance", target_km: 13.6, from_km: 1, to_km: 2 },
        ],
      },
      ENV,
    );
    expect(
      summarizeRoute(done.route, done.version).distance_m / 1000,
    ).toBeCloseTo(13.6, 0);
  });

  it("reverses the route and its sections", async () => {
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [{ op: "reverse" }],
      },
      ENV,
    );
    const summary = summarizeRoute(done.route, done.version);
    expect(summary.segments.map((s) => s.kind)).toEqual([
      "activity",
      "out_and_back",
      "activity",
    ]);
    // The recording ends a few metres short of 12.03 km.
    const source = summary.segments[0]!.source as {
      from_km: number;
      to_km: number;
    };
    expect(source.from_km).toBeCloseTo(12.03, 1);
    expect(source.to_km).toBeCloseTo(5.27, 2);
    const before = versionTrack(v1.route, v1.version);
    const after = versionTrack(done.route, done.version);
    expect(
      haversineMeters(after.coordinates[0]!, before.coordinates.at(-1)!),
    ).toBeLessThan(1);
    // The climb is now a descent-then-climb the other way; still recorded.
    expect(summary.segments[0]!.climb_source).toBe("recorded");
  });

  it("names the via points when one is missing", async () => {
    const v1 = await stitchSunday();
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [{ op: "remove_via", via_id: "v99" }],
        },
        ENV,
      ),
    ).rejects.toThrow(
      /its via points are v\d+ \(Turnaround toward Iron Cove, Sydney\)/,
    );
  });

  it("keeps undo and restore alone", async () => {
    const v1 = await stitchSunday();
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [{ op: "reverse" }, { op: "undo" }],
        },
        ENV,
      ),
    ).rejects.toThrow(/undo must be the only operation/);
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [{ op: "undo" }],
        },
        ENV,
      ),
    ).rejects.toThrow(/nothing to undo/);
  });

  it("stores nothing when routing fails part-way", async () => {
    const v1 = await stitchSunday();
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [
            { op: "reverse" },
            { op: "insert_via", km: 2, place: "In the harbour" },
          ],
        },
        ENV,
      ),
    ).rejects.toThrow(/no walkable path/);
    expect((await readRoute(v1.route.route_id))!.versions).toHaveLength(1);
  });
});

describe("layout and suggestions", () => {
  it("lays sections end to end, counting the seams", async () => {
    const built = await stitchSunday();
    const { spans, track } = layoutSegments(
      versionSegments(built.route, built.version),
    );
    expect(spans[0]!.start_m).toBe(0);
    expect(spans.at(-1)!.end_m).toBeCloseTo(trackLength(track), 3);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i]!.start_m).toBeGreaterThanOrEqual(spans[i - 1]!.end_m);
  });

  it("stores a stitched suggestion as one segment per section", async () => {
    const mk = (a: number, b: number) =>
      fakeOrsRoute("k", {
        waypoints: [sundayPointAt(a), sundayPointAt(b)],
      }).track;
    const [t1, t2, t3] = [mk(0, 1), mk(1, 2), mk(2, 3)];
    const track = concatTracks([t1, t2, t3]);
    const id = await storeSuggestedRoute({
      name: "Stitched",
      track,
      climb_m: 5,
      path_share: null,
      shape: "point-to-point",
      sections: [
        {
          kind: "run",
          track: t1,
          run: { id: "a1", name: "Sat run" },
          from_m: 1234,
          to_m: 500,
        },
        {
          kind: "corridor",
          track: t2,
          route_id: "cabcdefghij",
          version: 2,
          name: "Foreshore",
          reversed: false,
        },
        { kind: "fill", track: t3 },
      ],
    });
    const { route, version } = await loadRouteVersion(id);
    const segments = versionSegments(route, version);
    expect(segments.map((s) => [s.kind, s.label])).toEqual([
      ["activity", "Sat run km 1.23-0.50"],
      ["route", "Foreshore"],
      ["generated", "Routed join"],
    ]);
    expect(segments[0]!.source).toMatchObject({
      type: "activity",
      activity_id: "a1",
      from_km: 1.234,
      to_km: 0.5,
    });
    expect(segments[1]!.source).toMatchObject({
      type: "route",
      route_id: "cabcdefghij",
      version: 2,
      from_km: 0,
    });
    expect(segments[2]!.source).toEqual({ type: "ors", purpose: "route" });
    const laid = layoutSegments(segments).track;
    expect(Math.abs(trackLength(laid) - trackLength(track))).toBeLessThan(3);
  });

  it("stores a suggested route once, by its track", async () => {
    const track = fakeOrsRoute("k", {
      waypoints: [PLACES["Iron Cove, Sydney"]!, sundayPointAt(1)],
    }).track;
    const input = {
      name: "New loop",
      track,
      climb_m: 12,
      path_share: 0.4,
      shape: "loop",
    };
    const id = await storeSuggestedRoute(input);
    expect(id).toMatch(/^s[a-z2-7]{10}$/);
    expect(await storeSuggestedRoute(input)).toBe(id);
    const { route, version } = await loadRouteVersion(id);
    expect(summarizeRoute(route, version)).toMatchObject({
      kind: "suggestion",
      climb_m: 12,
      path_share: 0.4,
    });
    expect(trackDiff(track, versionTrack(route, version)).changed).toBe(false);
  });

  it("reports a route that is not stored, and a version it does not have", async () => {
    await expect(loadRouteVersion("rabcdefghij")).rejects.toThrow(
      /No stored route/,
    );
    const built = await stitchSunday();
    await expect(loadRouteVersion(built.route.route_id, 9)).rejects.toThrow(
      /no version 9/,
    );
  });
});

describe("refusals worded for the athlete", () => {
  async function amend(operations: unknown[], base = 1) {
    const v1 = await stitchSunday();
    return amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: base,
        operations: operations as never,
      },
      ENV,
    );
  }

  it.each([
    [
      [{ op: "insert_via", km: 30, place: "Callan Park, Sydney" }],
      /km 30 is outside this route, which is 13\.0\d km long/,
    ],
    [
      [{ op: "replace_section", from_km: 3, to_km: 2 }],
      /from_km 3 must be before to_km 2/,
    ],
    [
      [{ op: "trim", from_km: 0, to_km: 13.05 }],
      /trim would remove the whole route/,
    ],
    [
      [{ op: "move_via", via_id: "v4" }],
      /move_via needs to \(a place\) or shift/,
    ],
    [
      [
        {
          op: "move_via",
          via_id: "v4",
          shift: { direction: "uphill", distance_m: 50 },
        },
      ],
      /"uphill" is not a direction/,
    ],
    [
      [{ op: "fit_distance", target_km: 14, from_km: 1 }],
      /needs both from_km and to_km/,
    ],
    [[{ op: "fit_distance", target_km: 5 }], /cannot make it 5 km/],
    [
      [{ op: "insert_via", km: 1, place: "Nowhere at all" }],
      /No place matched "Nowhere at all"/,
    ],
    [[], /at least one operation/],
  ])("%j", async (operations, message) => {
    await expect(amend(operations)).rejects.toThrow(message);
  });

  it("needs a flexible section, or one range, to fit", async () => {
    const built = await stitchRoute(
      "key",
      { segments: [{ type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 4 }] },
      ENV,
    );
    await expect(
      amendRoute(
        "key",
        {
          route_id: built.route.route_id,
          base_version: 1,
          operations: [{ op: "fit_distance", target_km: 5 }],
        },
        ENV,
      ),
    ).rejects.toThrow(/No section is marked flexible/);
  });

  it("will not shorten a routed section past its via points", async () => {
    const v1 = await stitchSunday();
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [
            { op: "insert_via", km: 1.5, place: "Callan Park, Sydney" },
            { op: "fit_distance", target_km: 12.9, from_km: 0.5, to_km: 2.5 },
          ],
        },
        ENV,
      ),
    ).rejects.toThrow(/at least \d\.\d\d km through its via points/);
  });

  it("needs at, or a section before, for an out-and-back", async () => {
    await expect(
      stitchRoute(
        "key",
        {
          segments: [{ type: "out_and_back", toward: "west", distance_km: 1 }],
        },
        ENV,
      ),
    ).rejects.toThrow(/needs at/);
  });

  it("needs an end for a generated section followed by one with no start", async () => {
    await expect(
      stitchRoute(
        "key",
        {
          segments: [
            { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 1 },
            { type: "generated" },
            { type: "generated", via: ["Callan Park, Sydney"] },
          ],
        },
        ENV,
      ),
    ).rejects.toThrow(
      /Segment 2 is generated and nothing after it says where it ends/,
    );
  });

  it("routes a generated section to the next out-and-back's at", async () => {
    const at = sundayPointAt(2);
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 1 },
          { type: "generated" },
          {
            type: "out_and_back",
            at: `${at[0]},${at[1]}`,
            toward: "south",
            distance_km: 0.5,
          },
        ],
      },
      ENV,
    );
    const kinds = summarizeRoute(built.route, built.version).segments.map(
      (s) => s.kind,
    );
    expect(kinds).toEqual(["activity", "generated", "out_and_back"]);
  });

  it("drops an empty generated section between ends that meet", async () => {
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 1 },
          { type: "generated" },
          { type: "activity", id: SUNDAY_ID, from_km: 1, to_km: 2 },
        ],
      },
      ENV,
    );
    expect(built.ors_calls).toBe(0);
    expect(built.version.segment_ids).toHaveLength(2);
  });

  it("notes an out-and-back cut short by the way to its place", async () => {
    const at = moveTowardPoint(PLACES["Callan Park, Sydney"]!, 300);
    const built = await stitchRoute(
      "key",
      {
        segments: [
          {
            type: "out_and_back",
            at: `${at[0]},${at[1]}`,
            toward: "Callan Park, Sydney",
            distance_km: 2,
          },
        ],
      },
      ENV,
    );
    const summary = summarizeRoute(built.route, built.version);
    expect(summary.segments[0]!.notes[0]).toMatch(
      /The way toward Callan Park, Sydney is 0\.30 km, so this out-and-back is 0\.60 km, not 2\.00 km/,
    );
    // The note stays with its section; the warnings only point at it.
    expect(summary.warnings).toEqual([
      "Section 1 has notes; read them with each section.",
    ]);
  });

  it("counts the sections with notes in one warning line", async () => {
    const at = moveTowardPoint(PLACES["Callan Park, Sydney"]!, 300);
    const built = await stitchRoute(
      "key",
      {
        segments: [1, 2].map((n) => ({
          type: "out_and_back" as const,
          at: `${at[0]},${at[1]}`,
          toward: "Callan Park, Sydney",
          distance_km: n + 1,
        })),
      },
      ENV,
    );
    const summary = summarizeRoute(built.route, built.version);
    const noted = summary.segments.filter((s) => s.notes.length > 0);
    expect(noted.map((s) => s.index)).toEqual([1, 2]);
    const counts = summary.warnings.filter((w) => w.includes("have notes"));
    expect(counts).toEqual([
      "2 sections have notes (1, 2); read them with each section.",
    ]);
    expect(summary.warnings.join("\n")).not.toMatch(/The way toward/);
  });

  it("takes a stored route backwards, and refuses a version it does not have", async () => {
    const sunday = await stitchSunday();
    const built = await stitchRoute(
      "key",
      {
        segments: [
          {
            type: "route",
            route_id: sunday.route.route_id,
            from_km: 2,
            to_km: 1,
          },
        ],
      },
      ENV,
    );
    const track = versionTrack(built.route, built.version);
    expect(
      haversineMeters(track.coordinates[0]!, sundayPointAt(2)),
    ).toBeLessThan(5);
    await expect(
      stitchRoute(
        "key",
        {
          segments: [
            { type: "route", route_id: sunday.route.route_id, version: 4 },
          ],
        },
        ENV,
      ),
    ).rejects.toThrow(/has no version 4; its latest is 1/);
    await expect(
      stitchRoute(
        "key",
        { segments: [{ type: "route", route_id: "rabcdefghij" }] },
        ENV,
      ),
    ).rejects.toThrow(/No stored route has id rabcdefghij/);
  });

  it("reports a run with no GPS track", async () => {
    const { getActivityStreams } = await import("./intervalsClient");
    vi.mocked(getActivityStreams).mockResolvedValueOnce(
      sundayStreams().filter((s) => s.type !== "latlng") as never,
    );
    await expect(
      stitchRoute("key", { segments: [{ type: "activity", id: "i1" }] }, ENV),
    ).rejects.toThrow(/Activity i1 has no GPS track/);
  });
});

/** A point `metres` east of `point`. */
function moveTowardPoint(
  point: [number, number],
  metres: number,
): [number, number] {
  return [
    point[0],
    point[1] + metres / (111_320 * Math.cos((point[0] * Math.PI) / 180)),
  ];
}

describe("an out-and-back an edit has cut into parts", () => {
  it("moves its turnaround like a via point, keeping the route joined", async () => {
    const v1 = await stitchSunday();
    const turnaround = summarizeRoute(v1.route, v1.version).segments[1]!
      .vias[0]!;
    const cut = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          { op: "insert_via", km: 5.5, place: "Callan Park, Sydney" },
        ],
      },
      ENV,
    );
    const moved = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 2,
        operations: [
          {
            op: "move_via",
            via_id: turnaround.id,
            shift: { direction: "north", distance_m: 100 },
          },
        ],
      },
      ENV,
    );
    expect(cut.version.version).toBe(2);
    const summary = summarizeRoute(moved.route, moved.version);
    const via = summary.segments
      .flatMap((s) => s.vias)
      .find((v) => v.id === turnaround.id);
    expect(via).toBeDefined();
    // The route still starts and ends where it did.
    const before = versionTrack(v1.route, v1.version);
    const after = versionTrack(moved.route, moved.version);
    expect(
      haversineMeters(after.coordinates.at(-1)!, before.coordinates.at(-1)!),
    ).toBeLessThan(1);
    const segments = versionSegments(moved.route, moved.version);
    for (let i = 1; i < segments.length; i++)
      expect(
        haversineMeters(
          segments[i - 1]!.track.coordinates.at(-1)!,
          segments[i]!.track.coordinates[0]!,
        ),
      ).toBeLessThanOrEqual(30);
  });
});

describe("addCorridor", () => {
  const run = (
    name: string,
    source: Parameters<typeof addCorridor>[1]["source"],
  ) => addCorridor("key", { name, source }, ENV);
  const sunday = (extra: object) => ({
    type: "activity" as const,
    id: SUNDAY_ID,
    ...extra,
  });
  const latLng = (km: number) => sundayPointAt(km).join(",");

  it("stores a km range of a run as one activity section", async () => {
    const { route, created } = await run(
      "Bay Run",
      sunday({ from_km: 1, to_km: 3 }),
    );
    expect(created).toBe(true);
    expect(route.kind).toBe("corridor");
    expect(route.route_id).toMatch(/^c/);
    const segments = versionSegments(route, findVersion(route, 1)!);
    expect(segments.map((s) => s.kind)).toEqual(["activity"]);
    const length = trackLength(segments[0]!.track);
    expect(Math.abs(length - 2000) / 2000).toBeLessThan(0.02);
  });

  it("runs from the first pass of one place to the next pass of another", async () => {
    const { route } = await run(
      "Between",
      sunday({ from: latLng(1), to: latLng(3) }),
    );
    const [segment] = versionSegments(route, findVersion(route, 1)!);
    const source = segment!.source as { from_km: number; to_km: number };
    expect(source.from_km).toBeCloseTo(1, 1);
    expect(source.to_km).toBeCloseTo(3, 1);
  });

  it("refuses a from place that matched only a suburb", async () => {
    vi.mocked(ors.geocode).mockResolvedValue({
      label: "Glebe, NSW, Australia",
      point: sundayPointAt(1),
      match: { query: "Glebe", name: "Glebe", type: "locality" },
    });
    await expect(
      run("Suburb", sunday({ from: "Glebe", to: latLng(3) })),
    ).rejects.toThrow(/matched only Glebe \(a locality\)/);
  });

  it("refuses a place the run does not pass", async () => {
    await expect(
      run("Nowhere", sunday({ from: latLng(1), to: "-33.0,150.0" })),
    ).rejects.toThrow(/does not pass "-33.0,150.0"/);
  });

  it("says how near the run comes to a place it misses", async () => {
    const off = moveToward(sundayPointAt(1.5), 0, 300).join(",");
    const err = await run("Near", sunday({ from: latLng(1), to: off })).catch(
      (e) => e as Error,
    );
    const m = /comes closest at km (\d+\.\d+), (\d+) m away/.exec(
      (err as Error).message,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(1.5, 0);
    expect(Math.abs(Number(m![2]) - 300)).toBeLessThan(10);
  });

  it("says to swap from and to when the run passes them the other way", async () => {
    await expect(
      run("Backwards", sunday({ from: latLng(3), to: latLng(1) })),
    ).rejects.toThrow(
      /passes ".*" at km 1\.\d+, before ".*" at km 3\.\d+: it ran them the other way, so swap from and to\./,
    );
  });

  it("counts a park as passed anywhere within its reach", async () => {
    vi.mocked(ors.geocode).mockResolvedValue({
      label: "Big Park, Sydney",
      point: [-33.0, 150.0],
      match: { query: "Big Park", name: "Big Park", type: "venue" },
    });
    const spy = vi
      .spyOn(osmIndex, "parkReach")
      .mockReturnValue((p) => haversineMeters(p, sundayPointAt(3)) < 100);
    try {
      const { route } = await run(
        "Park",
        sunday({ from: latLng(1), to: "Big Park" }),
      );
      const [segment] = versionSegments(route, findVersion(route, 1)!);
      expect((segment!.source as { to_km: number }).to_km).toBeCloseTo(3, 0);
    } finally {
      spy.mockRestore();
    }
  });

  it("copies a range of a stored route", async () => {
    const built = await stitchSunday();
    const { route } = await run("From route", {
      type: "route",
      route_id: built.route.route_id,
      from_km: 0,
      to_km: 2,
    });
    const segments = versionSegments(route, findVersion(route, 1)!);
    expect(segments.map((s) => s.kind)).toEqual(["activity"]);
    expect(trackLength(segments[0]!.track)).toBeCloseTo(2000, -2);
  });

  it("refuses km and places together", async () => {
    await expect(
      run("Both", sunday({ from_km: 1, from: latLng(1), to: latLng(3) })),
    ).rejects.toThrow(RouteBuildError);
  });

  it("refuses a name with no words and a taken name", async () => {
    await expect(
      run("  !! ", sunday({ from_km: 1, to_km: 3 })),
    ).rejects.toThrow(/at least one word/);
    const first = await run("Bay Run", sunday({ from_km: 1, to_km: 3 }));
    await expect(
      run("run bay", sunday({ from_km: 4, to_km: 6 })),
    ).rejects.toThrow(new RegExp(`"Bay Run".*${first.route.route_id}`));
  });

  it("refuses a stretch under 200 m", async () => {
    await expect(
      run("Short", sunday({ from_km: 1, to_km: 1.1 })),
    ).rejects.toThrow(/at least 200 m/);
  });

  it("returns the saved corridor for the same add twice", async () => {
    const first = await run("Bay Run", sunday({ from_km: 1, to_km: 3 }));
    const again = await run("Bay Run", sunday({ from_km: 1, to_km: 3 }));
    expect(again.created).toBe(false);
    expect(again.route.route_id).toBe(first.route.route_id);
  });

  it("refuses the same range under another name, naming the saved one", async () => {
    await run("Bay Run", sunday({ from_km: 1, to_km: 3 }));
    await expect(
      run("Harbour Loop", sunday({ from_km: 1, to_km: 3 })),
    ).rejects.toThrow(/already saved as corridor "Bay Run"/);
  });
});

describe("corridors in stitchRoute and amendRoute", () => {
  const save = (name: string, one_way = false) =>
    addCorridor(
      "key",
      {
        name,
        one_way,
        source: { type: "activity", id: SUNDAY_ID, from_km: 4, to_km: 6 },
      },
      ENV,
    );
  const first = {
    type: "activity" as const,
    id: SUNDAY_ID,
    from_km: 0,
    to_km: 6,
  };
  const startOf = (segments: { track: { coordinates: number[][] } }[]) =>
    segments[0]!.track.coordinates[0] as [number, number];

  it("stores the corridor, reversed when the section before ends at its far end", async () => {
    await save("Bay Run");
    const built = await stitchRoute(
      "key",
      { segments: [first, { type: "corridor", name: "bay run" }] },
      ENV,
    );
    const segments = versionSegments(built.route, built.version);
    const corridorPart = segments.slice(1);
    expect(corridorPart.every((s) => s.label === "Bay Run")).toBe(true);
    expect(
      haversineMeters(startOf(corridorPart), sundayPointAt(6)),
    ).toBeLessThan(30);
    expect(trackLength(layoutSegments(corridorPart).track)).toBeCloseTo(
      2000,
      -2,
    );
  });

  it("makes a new route when a corridor is deleted and saved again under its name", async () => {
    const request = {
      segments: [{ type: "corridor" as const, name: "Bay Run" }],
    };
    const old = await save("Bay Run");
    const one = await stitchRoute("key", request, ENV);
    await deleteCorridor(old.route.route_id);
    await addCorridor(
      "key",
      {
        name: "Bay Run",
        source: { type: "activity", id: SUNDAY_ID, from_km: 1, to_km: 3 },
      },
      ENV,
    );
    const two = await stitchRoute("key", request, ENV);
    expect(two.created).toBe(true);
    expect(two.route.route_id).not.toBe(one.route.route_id);
  });

  it("runs it stored when the section before ends at its start", async () => {
    await save("Bay Run");
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 2, to_km: 4 },
          { type: "corridor", name: "Bay Run" },
        ],
      },
      ENV,
    );
    const part = versionSegments(built.route, built.version).slice(1);
    expect(haversineMeters(startOf(part), sundayPointAt(4))).toBeLessThan(30);
  });

  it("takes a km range of the corridor", async () => {
    await save("Bay Run");
    const built = await stitchRoute(
      "key",
      {
        segments: [{ type: "corridor", name: "Bay Run", from_km: 0, to_km: 1 }],
      },
      ENV,
    );
    const track = versionTrack(built.route, built.version);
    expect(trackLength(track)).toBeCloseTo(1000, -2);
  });

  it("refuses reversed on a one-way corridor", async () => {
    await save("Hill Climb", true);
    await expect(
      stitchRoute(
        "key",
        {
          segments: [{ type: "corridor", name: "Hill Climb", reversed: true }],
        },
        ENV,
      ),
    ).rejects.toThrow(/one-way/);
  });

  it("refuses an unknown name and suggests a near one", async () => {
    await save("Bay Run");
    await expect(
      stitchRoute(
        "key",
        { segments: [{ type: "corridor", name: "Bay" }] },
        ENV,
      ),
    ).rejects.toThrow(
      /No saved corridor is named "Bay"; did you mean "Bay Run"\?/,
    );
  });

  it("replaces a section with a corridor, labelled with its name", async () => {
    await save("Bay Run");
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          {
            op: "replace_section",
            from_km: 8,
            to_km: 10,
            corridor: { name: "Bay Run" },
          },
        ],
      },
      ENV,
    );
    const segments = versionSegments(done.route, done.version);
    expect(segments.some((s) => s.label === "Bay Run")).toBe(true);
  });

  it("runs a one-way corridor stored even when its km are given high to low", async () => {
    await save("Hill Climb", true);
    const built = await stitchRoute(
      "key",
      {
        segments: [
          { type: "activity", id: SUNDAY_ID, from_km: 8, to_km: 10 },
          { type: "corridor", name: "Hill Climb", from_km: 2, to_km: 0 },
        ],
      },
      ENV,
    );
    const part = versionSegments(built.route, built.version).filter(
      (s) => s.label === "Hill Climb",
    );
    expect(haversineMeters(startOf(part), sundayPointAt(4))).toBeLessThan(30);
  });

  it("runs reversed when asked, whatever order the km are given", async () => {
    await save("Bay Run");
    const built = await stitchRoute(
      "key",
      {
        segments: [
          {
            type: "corridor",
            name: "Bay Run",
            from_km: 2,
            to_km: 0,
            reversed: true,
          },
        ],
      },
      ENV,
    );
    const part = versionSegments(built.route, built.version);
    expect(haversineMeters(startOf(part), sundayPointAt(6))).toBeLessThan(30);
  });

  it("starts an amended corridor section at the end nearer the replaced range", async () => {
    await save("Bay Run");
    const v1 = await stitchSunday();
    const done = await amendRoute(
      "key",
      {
        route_id: v1.route.route_id,
        base_version: 1,
        operations: [
          {
            op: "replace_section",
            from_km: 8,
            to_km: 10,
            corridor: { name: "Bay Run" },
          },
        ],
      },
      ENV,
    );
    const part = versionSegments(done.route, done.version).filter(
      (s) => s.label === "Bay Run",
    );
    // km 8 of the route is nearer the corridor's far end (run km 6) than its start (km 4).
    expect(haversineMeters(startOf(part), sundayPointAt(6))).toBeLessThan(30);
  });

  it("refuses more than one of through, activity and corridor", async () => {
    await save("Bay Run");
    const v1 = await stitchSunday();
    await expect(
      amendRoute(
        "key",
        {
          route_id: v1.route.route_id,
          base_version: 1,
          operations: [
            {
              op: "replace_section",
              from_km: 8,
              to_km: 10,
              through: "Callan Park, Sydney",
              corridor: { name: "Bay Run" },
            },
          ],
        },
        ENV,
      ),
    ).rejects.toThrow("Pass one of through, activity or corridor.");
  });
});
