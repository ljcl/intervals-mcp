import { describe, expect, it } from "vitest";
import { type LatLng } from "./mapAnchors";
import { exportRoute, MAX_FILE_CHARS } from "./routeExport";
import { moveToward, trackFromPoints, trackLength } from "./routeGeometry";

/** A zig-zag east, so simplification has corners to keep. */
function zigzag(km: number): ReturnType<typeof trackFromPoints> {
  const points: LatLng[] = [[-33.86, 151.17]];
  for (let m = 5; m <= km * 1000; m += 5) {
    const base = moveToward([-33.86, 151.17], 90, m);
    points.push(moveToward(base, 0, ((m / 5) % 2) * 3));
  }
  return trackFromPoints(
    points,
    points.map((_, i) => 10 + (i % 7)),
  );
}

describe("exportRoute", () => {
  it("writes a GPX course with km markers and pins, escaping text", () => {
    const file = exportRoute("gpx", {
      name: "Rozelle <loop> & back",
      track: zigzag(2.5),
      kmMarkers: true,
      pins: [
        { km: 1.5, label: "Gel", kind: "fuel" },
        { km: 9, label: "Past the end" },
      ],
    });
    expect(file.text).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<gpx version="1.1"/,
    );
    expect(file.text).toContain("<name>Rozelle &lt;loop&gt; &amp; back</name>");
    expect(file.text).toContain("<name>km 1</name><type>km</type>");
    expect(file.text).toContain("<name>km 2</name>");
    expect(file.text).toContain("<name>Gel</name><type>fuel</type>");
    expect(file.text).not.toContain("Past the end");
    // The zig-zag makes km markers at 1 and 2 km of its own length, plus the pin.
    expect(file.waypoints).toBe(
      1 + Math.floor(trackLength(zigzag(2.5)) / 1000),
    );
    expect(file.text.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(file.text).toMatch(
      /<trkpt lat="-33\.\d{6}" lon="151\.\d{6}"><ele>\d+\.\d<\/ele><\/trkpt>/,
    );
  });

  it("writes GeoJSON: the line, then a point per marker, lng first", () => {
    const file = exportRoute("geojson", {
      name: "Loop",
      track: zigzag(1.2),
      kmMarkers: true,
      pins: [],
      properties: { route_id: "rabcdefghij", version: 2 },
    });
    const geo = JSON.parse(file.text);
    expect(geo.type).toBe("FeatureCollection");
    expect(geo.features[0].properties).toMatchObject({
      name: "Loop",
      route_id: "rabcdefghij",
      version: 2,
    });
    expect(geo.features[0].geometry.coordinates[0]).toEqual([
      151.17, -33.86, 10,
    ]);
    expect(geo.features[1]).toMatchObject({
      properties: { name: "km 1", kind: "km" },
      geometry: { type: "Point" },
    });
  });

  it("simplifies a long track until the file fits", () => {
    const file = exportRoute("gpx", {
      name: "Long",
      track: zigzag(10),
      kmMarkers: true,
      pins: [],
    });
    expect(file.text.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(file.simplified_m).toBeGreaterThan(1);
    expect(file.waypoints).toBe(Math.floor(trackLength(zigzag(10)) / 1000));
  });

  it("leaves out km markers when asked", () => {
    const file = exportRoute("gpx", {
      name: "x",
      track: zigzag(2),
      kmMarkers: false,
      pins: [],
    });
    expect(file.waypoints).toBe(0);
    expect(file.text).not.toContain("<wpt");
  });
});
