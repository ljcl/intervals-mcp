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
  sundayPointAt,
  sundayStreams,
} from "./__fixtures__/sundayRoute";
import { haversineMeters } from "./mapAnchors";
import * as ors from "./orsClient";
import { moveToward } from "./routeGeometry";
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
const { readRouteExport } = await import("./tools/exportRoute");

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
  it("gives each via's point and match, and warns on a coarse match or two vias at one point", async () => {
    const pyrmont = moveToward(sundayPointAt(5.27), 0, 300);
    vi.mocked(ors.geocode).mockImplementation(async (_key, text) => ({
      label: "Pyrmont, NSW, Australia",
      point: pyrmont,
      match: { query: text, name: "Pyrmont", type: "locality" },
    }));
    const result = await call("stitch-route", {
      name: "Wharves",
      segments: [
        { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 5.27 },
        {
          type: "generated",
          via: [
            "Jones Bay Wharf, Pyrmont, Sydney",
            "Darling Island, Pyrmont, Sydney",
          ],
        },
        { type: "activity", id: SUNDAY_ID, from_km: 5.27, to_km: 12.03 },
      ],
    });
    expect(result.isError, result.text).toBeUndefined();
    const { segments, warnings } =
      result.structuredContent as StoredRouteStructured;
    expect(segments[1]!.vias[0]).toMatchObject({
      lat: Number(pyrmont[0].toFixed(6)),
      lng: Number(pyrmont[1].toFixed(6)),
      label: "Jones Bay Wharf, Pyrmont, Sydney",
      match_name: "Pyrmont",
      match_type: "locality",
    });
    expect(result.text).toMatch(
      /\(-33\.\d{5},151\.\d{5}, matched Pyrmont, locality; on the route at -33\.\d{5},151\.\d{5}, \d+ m away\)/,
    );
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /^Via v\d+ "Jones Bay Wharf, Pyrmont, Sydney" matched Pyrmont, a locality, not a venue or address/,
      ),
    );
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /^Vias v\d+ "Jones Bay Wharf, Pyrmont, Sydney" and v\d+ "Darling Island, Pyrmont, Sydney" resolved within 50 m/,
      ),
    );
    // An activity section's points are not lookups.
    expect(segments[0]!.vias).toEqual([]);
  });

  /** A via 60 m past the section's end, in line with it: the fake router goes out to it and back. */
  /** A point `metres` past km 6 of Sunday, in line from km 5.27: the fake router goes out to it and back. */
  function pastEnd(metres: number) {
    const a = sundayPointAt(5.27);
    const b = sundayPointAt(6);
    const t = 1 + metres / haversineMeters(a, b);
    return `${(a[0] + (b[0] - a[0]) * t).toFixed(6)},${(a[1] + (b[1] - a[1]) * t).toFixed(6)}`;
  }

  function stubStitch(via: string[], snap?: "through") {
    return call("stitch-route", {
      name: "Stub",
      segments: [
        { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 5.27 },
        { type: "generated", via },
        { type: "activity", id: SUNDAY_ID, from_km: 6, to_km: 12.03 },
      ],
      ...(snap ? { snap } : {}),
    });
  }

  it("warns when a routed section goes back the way it came, and says where the via meets the route", async () => {
    const result = await stubStitch([pastEnd(60)]);
    const { segments, warnings } =
      result.structuredContent as StoredRouteStructured;
    const [via] = segments[1]!.vias;
    expect(warnings).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Section 2 goes back the way it came at km \\d\\.\\d\\d-\\d\\.\\d\\d, \\d+ m each way, around ${via!.id}:`,
        ),
      ),
    );
    expect(via!.snap_m).toBeLessThanOrEqual(5);
    expect(via!.moved_m).toBe(0);
    expect(via!.match_name).toBeNull();
    expect(result.text).toMatch(
      /on the route at -33\.\d{5},151\.\d{5}, \d m away\)/,
    );
  });

  it("moves a via off a dead end with snap through, keeping where it was asked for", async () => {
    const asked = pastEnd(30);
    const nearest = (await stubStitch([asked]))
      .structuredContent as StoredRouteStructured;
    const result = await stubStitch([asked], "through");
    const { warnings, ors_calls, route_id, segments } =
      result.structuredContent as StoredRouteStructured;
    expect(route_id).not.toBe(nearest.route_id);
    expect(ors_calls).toBe(nearest.ors_calls + 1);
    expect(warnings.join("\n")).not.toMatch(/the way it came/);
    expect(segments[1]!.notes).toContainEqual(
      expect.stringMatching(
        /^Via .* was on a way the route went along and back, so it was moved \d+ m to where the route passes it/,
      ),
    );
    // A section's note is not repeated in the warnings, only counted.
    expect(warnings.join("\n")).not.toMatch(/was on a way the route went/);
    expect(warnings).toContain(
      "Section 2 has notes; read them with each section.",
    );
    expect(result.text).toMatch(
      /\n {3}Note: Via .* was on a way the route went along and back/,
    );
    const [via] = segments[1]!.vias;
    expect(`${via!.lat.toFixed(6)},${via!.lng.toFixed(6)}`).toBe(asked);
    expect(via!.label).toBe(asked);
    expect(via!.moved_m).toBeGreaterThan(25);
    expect(via!.moved_m).toBeLessThanOrEqual(50);
    expect(via!.snap_m).toBeGreaterThanOrEqual(via!.moved_m - 5);
    expect(result.text).toMatch(/moved \d+ m by snap through\)/);
  });

  it("keeps a via snap through would move more than 50 m, and warns", async () => {
    const result = await stubStitch([pastEnd(80)], "through");
    const { warnings, segments } =
      result.structuredContent as StoredRouteStructured;
    expect(segments[1]!.vias[0]!.moved_m).toBe(0);
    expect(segments[1]!.notes).toContainEqual(
      expect.stringMatching(
        /Via .* is on a way the route goes along and back; the nearest point it passes through is \d+ m away, more than the 50 m snap through moves a via, so it was kept/,
      ),
    );
    expect(warnings).toContainEqual(
      expect.stringMatching(/^Section 2 goes back the way it came/),
    );
  });

  it("merges two vias snap through moves to one point", async () => {
    const result = await stubStitch([pastEnd(20), pastEnd(30)], "through");
    const { warnings, segments } =
      result.structuredContent as StoredRouteStructured;
    expect(segments[1]!.vias).toHaveLength(1);
    expect(segments[1]!.notes).toContainEqual(
      expect.stringMatching(
        /Via .* was merged into via .*: snap through put both at one point\./,
      ),
    );
    expect(warnings).toContain(
      "Section 2 has notes; read them with each section.",
    );
  });

  it("warns when consecutive vias are at one point", async () => {
    const a = sundayPointAt(5.27);
    const b = sundayPointAt(6);
    const side = moveToward(
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      0,
      haversineMeters(a, b) / 2,
    );
    const at = `${side[0].toFixed(6)},${side[1].toFixed(6)}`;
    const again = `${side[0].toFixed(5)},${side[1].toFixed(5)}`;
    const result = await stubStitch([at, again]);
    const { warnings } = result.structuredContent as StoredRouteStructured;
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /^Vias v\d+ and v\d+ are at one point \(km [\d.]+\), so the route between them goes nowhere/,
      ),
    );
  });

  it("refuses a key a segment does not take, rather than ignoring it", async () => {
    const result = await call("stitch-route", {
      segments: [
        { type: "activity", id: SUNDAY_ID, from_km: 0, to_km: 5.27 },
        { type: "generated", via: [pastEnd(30)], snap: "through" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/snap/);
  });

  it("labels the path share as partial when past-run sections have none", async () => {
    const { text } = await stitchSunday();
    expect(text).toMatch(
      /path share partial: 60% on paths over the \d+% of the distance that was routed; unknown for sections from past runs/,
    );
  });

  it("warns when the out-and-back climbs", async () => {
    vi.mocked(ors.orsRoute).mockImplementation(async (key, request) => {
      const route = fakeOrsRoute(key, request);
      route.track.altitude = route.track.distance.map((d) => 20 + d * 0.03);
      return route;
    });
    const { structured } = await stitchSunday();
    expect(structured.segments[1]!.notes).toContainEqual(
      expect.stringMatching(/^It climbs 1\d m in 1\.00 km .* not flat/),
    );
    expect(structured.warnings).toContain(
      "Section 2 has notes; read them with each section.",
    );
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

  it("maps a route id sent as id, as a host holding the old schema sends it", async () => {
    const { structured } = await stitchSunday();
    const result = await call("view-route-map", { id: structured.route_id });
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toContain(`Route ${structured.route_id} version 1`);
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
  it("links a GPX of the version asked, as long as that version (acceptance 5)", async () => {
    const { structured: v1 } = await stitchSunday();
    const result = await call("export-route", {
      route_id: v1.route_id,
      waypoints: [{ km: 8.8, label: "Anzac Bridge" }],
    });
    expect(result.isError, result.text).toBeUndefined();
    const [link] = result.attachments ?? [];
    expect(link).toMatchObject({
      type: "resource_link",
      name: `${v1.route_id}-v1.gpx`,
      mimeType: "application/gpx+xml",
    });
    expect(result.text).toContain(`GPX file linked: ${v1.route_id}-v1.gpx`);
    const { uri, size } = link as { uri: string; size: number };
    // A later version does not change what the link reads: it pins version 1.
    await call("amend-route", {
      route_id: v1.route_id,
      base_version: 1,
      operations: [{ op: "reverse" }],
    });
    const file = await readRouteExport(uri, "test-token");
    expect(file).toMatchObject({ uri, mimeType: "application/gpx+xml" });
    const gpx = file!.text;
    expect(Buffer.byteLength(gpx)).toBe(size);
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
    const { uri } = result.attachments![0] as { uri: string };
    const file = (await readRouteExport(uri, "test-token"))!;
    const geo = JSON.parse(file.text) as {
      features: Array<{ geometry: { type: string } }>;
    };
    expect(geo.features[0]!.geometry.type).toBe("LineString");
    expect(
      geo.features.filter((f) => f.geometry.type === "Point"),
    ).toHaveLength(12);
  });

  it("reads no file for a malformed link or a route no longer stored", async () => {
    expect(await readRouteExport("route-export://file/x.gpx", "t")).toBeNull();
    expect(
      await readRouteExport(
        `route-export://file/x.gpx?args=${encodeURIComponent('{"route_id":"rabcdefghij","format":"gpx","km_markers":true}')}`,
        "t",
      ),
    ).toBeNull();
  });

  it("needs route_id or id", async () => {
    const result = await call("export-route", {});
    expect(result.isError).toBe(true);
  });
});
