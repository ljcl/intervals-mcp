export interface RouteMapContextInput {
  name: string | null;
  activityType: string | null;
  distanceKm: number;
  elevationGain: number;
  hasGeometry: boolean;
  /** Label of the metric the track is colored by, when streams are present. */
  colorMetric?: string | null;
  /**
   * How far the map is zoomed in, when it is. Echoed back so a model
   * that called `set-viewport` — or a user who pinched — knows the view is no
   * longer showing the whole course.
   */
  zoom?: string | null;
}

/**
 * One-line summary of what the map shows, reported to the host's model context
 * so the assistant can reference the view without re-fetching.
 */
export function buildRouteMapContextSummary(
  input: RouteMapContextInput,
): string | null {
  const {
    name,
    activityType,
    distanceKm,
    elevationGain,
    hasGeometry,
    colorMetric,
    zoom,
  } = input;
  if (!name) return null;

  const kind = activityType ? `${activityType} activity` : "activity";
  const parts = [`Viewing the map for ${kind} "${name}".`];

  if (hasGeometry) {
    parts.push(`Distance ${distanceKm.toFixed(1)} km.`);
    if (elevationGain > 0) {
      parts.push(`Elevation gain ${Math.round(elevationGain)} m.`);
    }
    if (colorMetric) {
      parts.push(`The track is coloured by ${colorMetric.toLowerCase()}.`);
    }
    if (zoom) parts.push(`${zoom}.`);
  } else {
    parts.push("No GPS track is available for it.");
  }

  return parts.join(" ");
}
