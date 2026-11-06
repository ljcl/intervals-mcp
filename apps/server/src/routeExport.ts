/**
 * Route files for export-route: GPX (a watch or app imports it as a
 * course) and GeoJSON (a client checks, joins or changes the geometry).
 * Pure text building; the one home for both formats. Each file is
 * simplified until it fits {@link MAX_FILE_CHARS}, so it rides in one tool
 * result.
 */
import { type LatLng, type RouteTrack } from "./mapAnchors";
import { pointAtDistance, simplifyTrack, trackLength } from "./routeGeometry";

/** The most characters one exported file may take: the response budget less room for the text. */
export const MAX_FILE_CHARS = 32_000;
/** Simplification tolerances tried in turn, metres; the first that fits wins. */
const TOLERANCES_M = [1, 2, 3, 5, 8, 12, 20, 35, 60];

export interface ExportPin {
  km: number;
  label: string;
  kind?: string;
}

export interface ExportInput {
  name: string;
  track: RouteTrack;
  /** A marker every km ("km 1", "km 2", …). */
  kmMarkers: boolean;
  pins: ExportPin[];
  /** Extra GeoJSON properties for the line (route id, version, sections). */
  properties?: Record<string, unknown>;
}

export interface ExportedFile {
  text: string;
  points: number;
  waypoints: number;
  simplified_m: number;
}

interface Marker {
  point: LatLng;
  altitude: number | null;
  name: string;
  kind: string;
}

function markers(input: ExportInput): Marker[] {
  const length = trackLength(input.track);
  const out: Marker[] = [];
  if (input.kmMarkers) {
    for (let k = 1; k * 1000 <= length; k++) {
      const at = pointAtDistance(input.track, k * 1000);
      out.push({ ...at, name: `km ${k}`, kind: "km" });
    }
  }
  for (const pin of input.pins) {
    if (pin.km * 1000 > length + 1) continue;
    const at = pointAtDistance(input.track, pin.km * 1000);
    out.push({ ...at, name: pin.label, kind: pin.kind ?? "custom" });
  }
  return out;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const xml = (text: string) => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

const coord = (value: number) => value.toFixed(6);
const ele = (value: number | null) =>
  value === null ? "" : `<ele>${value.toFixed(1)}</ele>`;

function gpxText(input: ExportInput, track: RouteTrack, marks: Marker[]) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="intervals-mcp" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${xml(input.name)}</name></metadata>`,
  ];
  for (const m of marks)
    lines.push(
      `<wpt lat="${coord(m.point[0])}" lon="${coord(m.point[1])}">${ele(m.altitude)}<name>${xml(m.name)}</name><type>${xml(m.kind)}</type></wpt>`,
    );
  lines.push(`<trk><name>${xml(input.name)}</name><trkseg>`);
  track.coordinates.forEach(([lat, lng], i) => {
    lines.push(
      `<trkpt lat="${coord(lat)}" lon="${coord(lng)}">${ele(track.altitude[i] ?? null)}</trkpt>`,
    );
  });
  lines.push("</trkseg></trk>", "</gpx>");
  return lines.join("\n");
}

const position = (point: LatLng, altitude: number | null) =>
  altitude === null
    ? [Number(coord(point[1])), Number(coord(point[0]))]
    : [
        Number(coord(point[1])),
        Number(coord(point[0])),
        Math.round(altitude * 10) / 10,
      ];

function geoJsonText(input: ExportInput, track: RouteTrack, marks: Marker[]) {
  return JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name: input.name,
          distance_m: Math.round(trackLength(input.track)),
          ...input.properties,
        },
        geometry: {
          type: "LineString",
          coordinates: track.coordinates.map((point, i) =>
            position(point, track.altitude[i] ?? null),
          ),
        },
      },
      ...marks.map((m) => ({
        type: "Feature",
        properties: { name: m.name, kind: m.kind },
        geometry: { type: "Point", coordinates: position(m.point, m.altitude) },
      })),
    ],
  });
}

/**
 * The file in `format`, simplified at the smallest tolerance that keeps it
 * under {@link MAX_FILE_CHARS}. Markers sit on the full track, so km 5 is
 * at 5 km whatever the simplification.
 */
export function exportRoute(
  format: "gpx" | "geojson",
  input: ExportInput,
): ExportedFile {
  const marks = markers(input);
  const render = format === "gpx" ? gpxText : geoJsonText;
  let best: ExportedFile | null = null;
  for (const tolerance of TOLERANCES_M) {
    const track = simplifyTrack(input.track, tolerance);
    const text = render(input, track, marks);
    best = {
      text,
      points: track.coordinates.length,
      waypoints: marks.length,
      simplified_m: tolerance,
    };
    if (text.length <= MAX_FILE_CHARS) break;
  }
  return best!;
}
