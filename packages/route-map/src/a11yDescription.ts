/**
 * Screen-reader description of the rendered map. Unlike the one-line
 * `buildRouteMapContextSummary` (which briefs the host's model), this narrates
 * the view for a non-visual user: what the activity is, how far and how
 * hilly, its shape (loop vs point-to-point) and geographic extent, and which
 * annotation layers are marked along the track. Both views render it — the
 * basemap as visually-hidden text next to the canvas, the SVG grid as its
 * `<desc>` element.
 */
export interface RouteMapA11yInput {
  name: string;
  activityType: string | null;
  distanceKm: number;
  elevationGain: number;
  /** Ordered `[lat, lng]` pairs; empty when there is no geometry. */
  coordinates: Array<[number, number]>;
  /** Metres above sea level, index-aligned with `coordinates`. */
  altitude?: (number | null)[];
  /** Label of the metric the track is coloured by, when streams are present. */
  colorMetric?: string | null;
  splitCount?: number;
  splitKind?: "laps" | "splits";
  waypointCount?: number;
}

const DEG_TO_RAD = Math.PI / 180;
/** Kilometres per degree of latitude (and of cos-scaled longitude). */
const KM_PER_DEGREE = 111.32;

/** Endpoints closer than this fraction of the total distance close a loop. */
const LOOP_DISTANCE_FRACTION = 0.02;
/** ... but GPS drift means endpoints this close always count as a loop. */
const LOOP_MIN_THRESHOLD_KM = 0.15;

const COMPASS_POINTS = [
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
] as const;

/** East–west / north–south bounding-box spans in km (equirectangular). */
export function extentSpansKm(coordinates: Array<[number, number]>): {
  ewKm: number;
  nsKm: number;
} | null {
  if (coordinates.length < 2) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of coordinates) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const midLat = (minLat + maxLat) / 2;
  return {
    ewKm: (maxLng - minLng) * KM_PER_DEGREE * Math.cos(midLat * DEG_TO_RAD),
    nsKm: (maxLat - minLat) * KM_PER_DEGREE,
  };
}

function endpointSeparationKm(coordinates: Array<[number, number]>): number {
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  if (!start || !end) return 0;
  const midLat = (start[0] + end[0]) / 2;
  const dLatKm = (end[0] - start[0]) * KM_PER_DEGREE;
  const dLngKm =
    (end[1] - start[1]) * KM_PER_DEGREE * Math.cos(midLat * DEG_TO_RAD);
  return Math.hypot(dLatKm, dLngKm);
}

/** 8-way compass label of the net start-to-finish direction. */
function bearingLabel(coordinates: Array<[number, number]>): string | null {
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  if (!start || !end) return null;
  const midLat = (start[0] + end[0]) / 2;
  const dx = (end[1] - start[1]) * Math.cos(midLat * DEG_TO_RAD);
  const dy = end[0] - start[0];
  if (dx === 0 && dy === 0) return null;
  const degrees = (Math.atan2(dx, dy) / DEG_TO_RAD + 360) % 360;
  return COMPASS_POINTS[Math.round(degrees / 45) % 8] ?? null;
}

function formatSpan(km: number): string {
  if (km < 1) return `${Math.round(km * 100) * 10} m`;
  return `${km >= 10 ? Math.round(km) : Number(km.toFixed(1))} km`;
}

function describeShape(
  coordinates: Array<[number, number]>,
  distanceKm: number,
): string | null {
  const spans = extentSpansKm(coordinates);
  if (!spans) return null;
  const loopThresholdKm = Math.max(
    LOOP_MIN_THRESHOLD_KM,
    distanceKm * LOOP_DISTANCE_FRACTION,
  );
  const loop = endpointSeparationKm(coordinates) <= loopThresholdKm;
  const direction = loop ? null : bearingLabel(coordinates);
  const shape = loop
    ? "A loop returning to its start"
    : `Point-to-point heading ${direction ?? "away from the start"}`;
  return `${shape}, spanning roughly ${formatSpan(spans.ewKm)} east to west and ${formatSpan(spans.nsKm)} north to south.`;
}

function altitudeRange(
  altitude: ReadonlyArray<number | null> | undefined,
): { min: number; max: number } | null {
  if (!altitude || altitude.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const value of altitude) {
    if (value == null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Infinity ? null : { min, max };
}

function describeAltitude(
  altitude: ReadonlyArray<number | null> | undefined,
): string | null {
  const range = altitudeRange(altitude);
  if (!range) return null;
  return `Altitude ranges from ${Math.round(range.min)} m to ${Math.round(range.max)} m.`;
}

/**
 * Narration for the linked elevation strip below the track. The strip
 * is its own role="img" SVG, so it carries its own <desc> alongside the
 * existing name label.
 */
export function buildElevationStripDescription(
  altitude: ReadonlyArray<number | null>,
  distanceKm: number,
): string {
  const range = altitudeRange(altitude);
  if (!range) return "No altitude data.";
  return `Altitude ranges from ${Math.round(range.min)} m to ${Math.round(range.max)} m over ${distanceKm.toFixed(1)} km.`;
}

function describeAnnotations(input: RouteMapA11yInput): string | null {
  const parts: string[] = [];
  if (input.splitCount) {
    parts.push(
      input.splitKind === "laps"
        ? `${input.splitCount} lap markers`
        : `${input.splitCount} kilometre splits`,
    );
  }
  if (input.waypointCount) {
    parts.push(
      input.waypointCount === 1
        ? "1 waypoint"
        : `${input.waypointCount} waypoints`,
    );
  }
  if (parts.length === 0) return null;
  return `Marked along the route: ${parts.join(", ")}.`;
}

export function buildRouteMapA11yDescription(input: RouteMapA11yInput): string {
  const kind = input.activityType
    ? `${input.activityType} activity`
    : "activity";
  const parts = [`Map of ${kind} "${input.name}".`];

  if (input.coordinates.length < 2) {
    parts.push("No GPS track is available.");
    return parts.join(" ");
  }

  const climb =
    input.elevationGain > 0
      ? ` with ${Math.round(input.elevationGain)} m of climbing`
      : "";
  parts.push(`${input.distanceKm.toFixed(1)} km${climb}.`);

  const shape = describeShape(input.coordinates, input.distanceKm);
  if (shape) parts.push(shape);

  const altitude = describeAltitude(input.altitude);
  if (altitude) parts.push(altitude);

  if (input.colorMetric) {
    parts.push(`The track is coloured by ${input.colorMetric.toLowerCase()}.`);
  }

  const annotations = describeAnnotations(input);
  if (annotations) parts.push(annotations);

  return parts.join(" ");
}
