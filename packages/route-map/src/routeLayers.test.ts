import { describe, expect, it } from "vitest";
import {
  comparedStoredRouteMap,
  olderStoredRouteMap,
  storedRouteMap,
  warnedStoredRouteMap,
} from "./__fixtures__/storedRoute";
import {
  buildSectionRuns,
  buildStretchMarkers,
  compareText,
  formatDistanceChange,
  routeKmMarkers,
  routeWarnings,
  SECTION_PALETTE,
  sectionColorRuns,
  sectionLegendText,
  versionText,
} from "./routeLayers";
import { type RouteMapRoute } from "./types";

const route = storedRouteMap.route!;

describe("buildSectionRuns", () => {
  it("colours sections in palette order and keeps their km", () => {
    const runs = buildSectionRuns(route, storedRouteMap.coordinates.length);
    expect(runs.map((r) => r.color)).toEqual(SECTION_PALETTE.slice(0, 5));
    expect(runs[1]).toMatchObject({
      index: 1,
      kind: "activity",
      startIndex: route.segments[1]!.startIndex,
      endIndex: route.segments[1]!.endIndex,
      fromKm: route.segments[1]!.from_km,
    });
  });

  it("wraps the palette and clamps indices to the track", () => {
    const many: RouteMapRoute = {
      ...route,
      segments: Array.from({ length: 8 }, (_, i) => ({
        ...route.segments[0]!,
        index: i,
        startIndex: i * 3 - 2,
        endIndex: i * 3 + 50,
      })),
    };
    const runs = buildSectionRuns(many, 10);
    expect(runs[6]!.color).toBe(SECTION_PALETTE[0]);
    expect(runs[0]!.startIndex).toBe(0);
    expect(runs[7]!.startIndex).toBe(9);
    expect(runs[7]!.endIndex).toBe(9);
  });

  it("is empty with no track", () => {
    expect(buildSectionRuns(route, 0)).toEqual([]);
  });
});

describe("sectionColorRuns", () => {
  it("gives the basemap concrete colours and drops empty sections", () => {
    const runs = buildSectionRuns(route, storedRouteMap.coordinates.length);
    runs.push({ ...runs[0]!, startIndex: 4, endIndex: 4 });
    expect(sectionColorRuns(runs).map((r) => r.color)).toEqual(
      SECTION_PALETTE.slice(0, 5).map((c) => c.hex),
    );
  });
});

describe("sectionLegendText", () => {
  it("names the km range, label and kind", () => {
    const [first] = buildSectionRuns(route, storedRouteMap.coordinates.length);
    expect(sectionLegendText({ ...first!, fromKm: 0, toKm: 3.25 })).toBe(
      "0.0–3.3 km · Rozelle to Iron Cove (routed)",
    );
    expect(
      sectionLegendText({ ...first!, kind: "something_new", label: "X" }),
    ).toMatch(/· X \(something_new\)$/);
  });
});

describe("routeKmMarkers", () => {
  it("labels each km marker", () => {
    const markers = routeKmMarkers(route);
    expect(markers[0]).toEqual({
      index: route.kmMarkers[0]!.index,
      label: "1 km",
    });
    expect(markers).toHaveLength(route.kmMarkers.length);
  });
});

describe("buildStretchMarkers", () => {
  it("keeps only waypoints with an end", () => {
    const stretches = buildStretchMarkers(storedRouteMap);
    expect(stretches).toHaveLength(1);
    expect(stretches[0]).toMatchObject({ kind: "climb", color: "#ef4444" });
    expect(stretches[0]!.title).toMatch(/^Anzac Bridge climb \+35 m · /);
  });

  it("uses the label alone without end_km", () => {
    const [w] = storedRouteMap.annotations!.waypoints!;
    const data = {
      ...storedRouteMap,
      annotations: { waypoints: [{ ...w!, end_km: undefined }] },
    };
    expect(buildStretchMarkers(data)[0]!.title).toBe(
      "Anzac Bridge climb +35 m",
    );
  });
});

describe("formatDistanceChange", () => {
  it.each([
    [240.4, "+240 m"],
    [-1234, "−1.2 km"],
    [0.2, "no change in distance"],
  ])("%d m reads %s", (metres, text) => {
    expect(formatDistanceChange(metres)).toBe(text);
  });
});

describe("versionText", () => {
  it("names the version and its change", () => {
    expect(versionText(route)).toEqual({
      title: "Version 3 of 3",
      change: "Added an out and back to Pyrmont",
    });
    expect(versionText(olderStoredRouteMap.route!).change).toBe(
      "Through Darling St, Balmain",
    );
    expect(versionText({ ...route, versions: [] }).change).toBeNull();
  });
});

describe("compareText", () => {
  it("is null without a compare", () => {
    expect(compareText(route)).toBeNull();
  });

  it("names the change on the shown version", () => {
    const compared = comparedStoredRouteMap.route!;
    const { change } = compared.compare!;
    expect(compareText(compared)).toBe(
      `Compared with version 2: version 3 is +${(change.distance_change_m / 1000).toFixed(1)} km against version 2; ${change.from_km.toFixed(1)}–${change.to_km.toFixed(1)} km changed.`,
    );
  });

  it("uses the older km when the older version is shown", () => {
    const compared = comparedStoredRouteMap.route!;
    const older: RouteMapRoute = {
      ...compared,
      version: 2,
      compare: {
        ...compared.compare!,
        version: 3,
        change: { ...compared.compare!.change, old_from_km: 1, old_to_km: 2 },
      },
    };
    expect(compareText(older)).toMatch(/; 1\.0–2\.0 km changed\.$/);
  });

  it("says when the line is the same", () => {
    const compared = comparedStoredRouteMap.route!;
    expect(
      compareText({
        ...compared,
        compare: {
          ...compared.compare!,
          change: { ...compared.compare!.change, changed: false },
        },
      }),
    ).toBe("Compared with version 2: the line is the same.");
  });
});

describe("routeWarnings", () => {
  it("lists section warnings by km, then pin warnings", () => {
    const warnings = routeWarnings(warnedStoredRouteMap);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]!.range).toMatch(/^\d+\.\d–\d+\.\d km$/);
    expect(warnings[2]).toEqual({
      range: null,
      text: 'Pin "Water, Iron Cove" moved from km 5.6 (version 2) to km 6 (version 3).',
    });
  });

  it("is empty without warnings", () => {
    expect(routeWarnings(storedRouteMap)).toEqual([]);
  });
});
