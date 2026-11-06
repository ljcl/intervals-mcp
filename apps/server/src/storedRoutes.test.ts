/**
 * The stored-route tools end to end through `dispatchToolCall`, on the
 * synthetic Sunday route (`__fixtures__/sundayRoute.ts`) with a fake
 * OpenRouteService: the acceptance scenarios of the route builder.
 * The routing budget is 3 calls here, so its limit is cheap to reach.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeGeocode,
  fakeOrsRoute,
  SUNDAY_ACTIVITY,
  SUNDAY_ID,
  sundayStreams,
} from "./__fixtures__/sundayRoute";
import * as ors from "./orsClient";
import { type RouteMapData } from "./routeMapData";
import { type StoredRouteStructured } from "./tools/_storedRoutes";

vi.mock("./orsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./orsClient")>()),
  orsRoute: vi.fn(),
  geocode: vi.fn(),
}));

vi.mock("./intervalsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intervalsClient")>()),
  getActivity: vi.fn(async () => structuredClone(SUNDAY_ACTIVITY)),
  getActivityStreams: vi.fn(async () => sundayStreams()),
}));

vi.mock("./routeSuggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./routeSuggestions")>()),
  ORS_CALL_BUDGET: 3,
}));

vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  getIntervalsApiKey: vi.fn(() => "test-token"),
  getOrsApiKey: vi.fn(() => "test-ors-key"),
}));

const { dispatchToolCall } = await import("./server");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stored-routes-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.mocked(ors.orsRoute).mockImplementation(async (key, request) =>
    fakeOrsRoute(key, request),
  );
  vi.mocked(ors.geocode).mockImplementation(async (key, text) =>
    fakeGeocode(key, text),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const APPS = { client: { rendersApps: true } };

async function call(
  name: string,
  args: Record<string, unknown>,
  options: Parameters<typeof dispatchToolCall>[2] = APPS,
) {
  const result = await dispatchToolCall(name, args, options);
  return {
    ...result,
    text: result.content.map((c) => c.text).join("\n"),
  };
}

/** Acceptance 1: km 0-5.27 of the Sunday run, 1 km toward Iron Cove and back, km 5.27-12.03. */
async function stitchSunday() {
  const result = await call("stitch-route", {
    name: "Sunday + Iron Cove",
    segments: [
      { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 5.27 },
      { type: "out_and_back", toward: "Iron Cove, Sydney", distance_km: 1 },
      { type: "activity", id: SUNDAY_ID, from_km: 5.27, to_km: 12.03 },
    ],
  });
  expect(result.isError, result.text).toBeUndefined();
  return {
    ...result,
    structured: result.structuredContent as StoredRouteStructured,
  };
}

async function mapData(args: Record<string, unknown>): Promise<RouteMapData> {
  const result = await call("get-route-map-data", args);
  expect(result.isError, result.text).toBeUndefined();
  return JSON.parse(result.text) as RouteMapData;
}

describe("stitch-route", () => {
  it("returns one route with its sections, no geometry and no wide gap", async () => {
    const { structured, text } = await stitchSunday();
    expect(structured.route_id).toMatch(/^r[a-z2-7]{10}$/);
    expect(structured.version).toBe(1);
    expect(structured.distance_m / 1000).toBeCloseTo(13.03, 1);
    expect(structured.segments).toHaveLength(3);
    expect(text).toContain(`Route ${structured.route_id} version 1 of 1`);
    expect(text).toMatch(
      /Turnaround v\d+ at km 5\.7\d: Turnaround toward Iron Cove, Sydney/,
    );
    expect(text).not.toMatch(/-33\.\d{4,}/);
    expect(JSON.stringify(structured)).not.toContain("coordinates");
  });

  it("is refused on the 2025 path, like every write", async () => {
    const result = await call(
      "stitch-route",
      { segments: [{ type: "activity", id: SUNDAY_ID }] },
      { readOnly: true },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/2025 protocol revision/);
  });
});

describe("view-route-map with a route_id", () => {
  it("shows the route as one line with its sections, km markers and a stretch pin", async () => {
    const { structured } = await stitchSunday();
    // Acceptance 2: the Anzac Bridge climb, km 7.8-9 of the run, is km 8.8-10 of the route.
    const data = await mapData({
      route_id: structured.route_id,
      waypoints: [
        { km: 8.8, end_km: 10, label: "Anzac Bridge climb", kind: "climb" },
      ],
    });
    expect(data.source).toBe("route");
    expect(data.route?.segments.map((s) => s.kind)).toEqual([
      "activity",
      "out_and_back",
      "activity",
    ]);
    expect(data.route?.kmMarkers).toHaveLength(13);
    expect(data.route?.editable).toBe(true);
    const pin = data.annotations?.waypoints?.[0];
    expect(pin).toMatchObject({ km: 8.8, end_km: 10, kind: "climb" });
    expect(pin!.endIndex).toBeGreaterThan(pin!.index);
    // The pinned stretch is where the altitude climbs.
    const altitude = data.streams!.altitude!;
    const rise =
      Math.max(...(altitude.slice(pin!.index, pin!.endIndex) as number[])) -
      (altitude[pin!.index] as number);
    expect(rise).toBeGreaterThan(20);
  });

  it("states the sections and pins in its text, and claims the map", async () => {
    const { structured } = await stitchSunday();
    const result = await call("view-route-map", {
      route_id: structured.route_id,
      waypoints: [
        { km: 8.8, end_km: 10, label: "Anzac Bridge climb", kind: "climb" },
      ],
    });
    expect(result.text).toMatch(/^Interactive route map shown\./);
    expect(result.text).toContain(
      "1. km 0.00-5.27 Sunday long run km 0.00-5.27",
    );
    expect(result.text).toContain("km 8.8-10: Anzac Bridge climb (climb)");
    expect(result.attachments).toBeUndefined();
  });

  it("gives a client without MCP Apps a PNG of the map (acceptance 6)", async () => {
    const { structured } = await stitchSunday();
    const result = await call(
      "view-route-map",
      { route_id: structured.route_id },
      { client: { rendersApps: false } },
    );
    expect(result.text).toMatch(/did not report MCP Apps support/);
    expect(result.text).toContain("(blue)");
    expect(result.text).toContain("A picture of the route is attached");
    const [image] = result.attachments ?? [];
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    const bytes = Buffer.from((image as { data: string }).data, "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.length).toBeLessThan(40_000);
  });

  it("gives an activity's map as a PNG too", async () => {
    const result = await call("view-route-map", { id: SUNDAY_ID }, {});
    expect(result.attachments?.[0]).toMatchObject({ type: "image" });
    expect(result.text).toContain("A picture of the track is attached");
  });

  it("refuses id and route_id together", async () => {
    const result = await call("view-route-map", {
      id: SUNDAY_ID,
      route_id: "rabcdefghij",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not both/);
  });

  it("reports a route that is not stored", async () => {
    const result = await call("view-route-map", { route_id: "rabcdefghij" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^❌ No stored route has id rabcdefghij/);
  });
});

describe("amend-route", () => {
  async function moveTurnaround(routeId: string, viaId: string) {
    const result = await call("amend-route", {
      route_id: routeId,
      base_version: 1,
      operations: [
        {
          op: "move_via",
          via_id: viaId,
          shift: { direction: "west", distance_m: 200 },
        },
      ],
    });
    expect(result.isError, result.text).toBeUndefined();
    return {
      ...result,
      structured: result.structuredContent as StoredRouteStructured,
    };
  }

  it("moves the turnaround 200 m west into version 2, naming the change (acceptance 3)", async () => {
    const { structured: v1 } = await stitchSunday();
    const turnaround = v1.segments[1]!.vias[0]!;
    const { structured: v2, text } = await moveTurnaround(
      v1.route_id,
      turnaround.id,
    );
    expect(v2).toMatchObject({ version: 2, latest_version: 2, applied: true });
    expect(v2.change?.distance_change_m).toBeCloseTo(400, -1);
    // Only the out-and-back changed.
    expect(v2.change?.old_from_km).toBeGreaterThanOrEqual(5.2);
    expect(v2.change?.old_to_km).toBeLessThanOrEqual(6.3);
    expect(v2.segments[0]!.distance_m).toBe(v1.segments[0]!.distance_m);
    expect(v2.segments[2]!.distance_m).toBe(v1.segments[2]!.distance_m);
    expect(text).toMatch(
      /Change from version 1: \+0\.4\d km; km 5\.\d\d-6\.\d\d changed/,
    );
  });

  it("compares version 2 with version 1, then restores version 1 (acceptance 4)", async () => {
    const { structured: v1 } = await stitchSunday();
    await moveTurnaround(v1.route_id, v1.segments[1]!.vias[0]!.id);
    const compared = await mapData({
      route_id: v1.route_id,
      compare_to_version: 1,
    });
    expect(compared.route?.compare?.version).toBe(1);
    expect(compared.route?.compare?.change.changed).toBe(true);
    expect(compared.route!.compare!.endIndex).toBeGreaterThan(
      compared.route!.compare!.startIndex,
    );
    const view = await call("view-route-map", {
      route_id: v1.route_id,
      compare_to_version: 1,
    });
    expect(view.text).toMatch(
      /Compared with version 1: version 2 is \+0\.4\d km/,
    );

    const restored = await call("amend-route", {
      route_id: v1.route_id,
      base_version: 2,
      operations: [{ op: "restore", version: 1 }],
    });
    const v3 = restored.structuredContent as StoredRouteStructured;
    expect(v3.version).toBe(3);
    expect(v3.distance_m).toBe(v1.distance_m);
    expect(v3.change?.distance_change_m).toBeCloseTo(-400, -1);
  });

  it("refuses a stale base version", async () => {
    const { structured: v1 } = await stitchSunday();
    await moveTurnaround(v1.route_id, v1.segments[1]!.vias[0]!.id);
    const stale = await call("amend-route", {
      route_id: v1.route_id,
      base_version: 1,
      operations: [{ op: "reverse" }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/^❌ Version 1 is not the latest version/);
  });

  it("keeps the last version and warns when a change needs more than the routing budget (acceptance 7)", async () => {
    const { structured: v1 } = await stitchSunday();
    const result = await call("amend-route", {
      route_id: v1.route_id,
      base_version: 1,
      operations: [
        { op: "add_out_and_back", km: 1, toward: "south", distance_km: 0.4 },
        { op: "add_out_and_back", km: 2, toward: "south", distance_km: 0.4 },
        { op: "add_out_and_back", km: 3, toward: "south", distance_km: 0.4 },
        { op: "add_out_and_back", km: 4, toward: "south", distance_km: 0.4 },
      ],
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as StoredRouteStructured;
    expect(structured).toMatchObject({
      applied: false,
      version: 1,
      latest_version: 1,
    });
    expect(result.text).toMatch(
      /Warning: No change was made: .*more than this call's 3 routing calls.* Version 1 is still the latest/,
    );
  });

  it("carries pins onto the new version: shifted after the change, kept where the new track still passes", async () => {
    const { structured: v1 } = await stitchSunday();
    const turnaround = v1.segments[1]!.vias[0]!;
    // West is straight on, so the new out-and-back passes the old turnaround.
    await moveTurnaround(v1.route_id, turnaround.id);
    const data = await mapData({
      route_id: v1.route_id,
      waypoints_version: 1,
      waypoints: [
        { km: 2, label: "Before", kind: "custom" },
        { km: turnaround.km, label: "Turn", kind: "custom" },
        { km: 8.8, end_km: 10, label: "Anzac Bridge climb", kind: "climb" },
      ],
    });
    const pins = data.annotations!.waypoints!;
    expect(pins.find((p) => p.label === "Before")!.km).toBe(2);
    expect(pins.find((p) => p.label === "Turn")!.km).toBeCloseTo(
      turnaround.km,
      1,
    );
    const climb = pins.find((p) => p.label === "Anzac Bridge climb")!;
    expect(climb.km).toBeCloseTo(9.2, 1);
    expect(climb.end_km).toBeCloseTo(10.4, 1);
    expect(data.waypointWarnings).toEqual([
      expect.stringMatching(
        /^Pin "Anzac Bridge climb" moved from km 8\.8 \(version 1\) to km 9\.2\d* \(version 2\)\.$/,
      ),
    ]);
  });

  it("warns for a pin whose part of the route moved away", async () => {
    const { structured: v1 } = await stitchSunday();
    const turnaround = v1.segments[1]!.vias[0]!;
    await call("amend-route", {
      route_id: v1.route_id,
      base_version: 1,
      operations: [
        {
          op: "move_via",
          via_id: turnaround.id,
          shift: { direction: "north", distance_m: 300 },
        },
      ],
    });
    const data = await mapData({
      route_id: v1.route_id,
      waypoints_version: 1,
      waypoints: [{ km: turnaround.km, label: "Turn", kind: "custom" }],
    });
    expect(data.waypointWarnings).toEqual([
      expect.stringMatching(
        /^Pin "Turn" was at km 5\.7\d* on version 1; that part changed in version 2, so km [\d.]+ may be wrong\.$/,
      ),
    ]);
    const view = await call("view-route-map", {
      route_id: v1.route_id,
      waypoints_version: 1,
      waypoints: [{ km: turnaround.km, label: "Turn", kind: "custom" }],
    });
    expect(view.text).toMatch(/Warning: Pin "Turn" was at km/);
  });
});

describe("export-route", () => {
  it("attaches a GPX of the version asked, as long as that version (acceptance 5)", async () => {
    const { structured: v1 } = await stitchSunday();
    const result = await call("export-route", {
      route_id: v1.route_id,
      version: 1,
      waypoints: [{ km: 8.8, label: "Anzac Bridge" }],
    });
    expect(result.isError, result.text).toBeUndefined();
    const [file] = result.attachments ?? [];
    expect(file).toMatchObject({
      type: "resource",
      resource: {
        mimeType: "application/gpx+xml",
        uri: `route-export://${v1.route_id}-v1.gpx`,
      },
    });
    const gpx = (file as { resource: { text: string } }).resource.text;
    expect(gpx.match(/<trk>/g)).toHaveLength(1);
    expect(gpx).toContain("<name>Sunday + Iron Cove (v1)</name>");
    expect(gpx).toContain("<name>km 13</name>");
    expect(gpx).toContain("<name>Anzac Bridge</name>");
    // The track in the file is as long as the version.
    const points = [
      ...gpx.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g),
    ].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
    const { trackFromPoints } = await import("./routeGeometry");
    const length = trackFromPoints(points).distance.at(-1)!;
    expect(Math.abs(length - v1.distance_m)).toBeLessThan(
      v1.distance_m * 0.005,
    );
    expect(result.structuredContent).toMatchObject({
      format: "gpx",
      version: 1,
      distance_m: v1.distance_m,
    });
    // The text has no geometry.
    expect(result.text).not.toContain("<trkpt");
  });

  it("exports a past run as GeoJSON", async () => {
    const result = await call("export-route", {
      id: SUNDAY_ID,
      format: "geojson",
    });
    const file = (result.attachments![0] as { resource: { text: string } })
      .resource;
    const geo = JSON.parse(file.text) as {
      features: Array<{ geometry: { type: string } }>;
    };
    expect(geo.features[0]!.geometry.type).toBe("LineString");
    expect(
      geo.features.filter((f) => f.geometry.type === "Point"),
    ).toHaveLength(12);
  });

  it("needs route_id or id", async () => {
    const result = await call("export-route", {});
    expect(result.isError).toBe(true);
  });
});
