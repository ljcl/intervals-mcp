import { type SuggestionPosition } from "./types";

export interface RouteMapContextInput {
  name: string | null;
  activityType: string | null;
  distanceKm: number;
  elevationGain: number;
  hasGeometry: boolean;
  /** Label of the metric the track is colored by, when streams are present. */
  colorMetric?: string | null;
  /**
   * Which stretch of the route the map shows, when it is not the whole of it
   * (`describeView`). Echoed back so a model that called `set-viewport`, or
   * a user who panned or pinched, knows what the map now shows.
   */
  visible?: string | null;
  /** A stored route: which one, which version, and what is compared. */
  route?: {
    routeId: string;
    version: number;
    latestVersion: number;
    sectionCount: number;
    compare: string | null;
  } | null;
  /** A line put first, e.g. the edit just made on the map. */
  note?: string | null;
  /** A suggested route: which option of which planned run. */
  suggestion?: SuggestionPosition | null;
}

/** "suggested route 2 of 3 ("New loop 2") for planned run "Easy" on 2026-10-20". */
export function suggestionPhrase(s: SuggestionPosition): string {
  return `suggested route ${s.option} of ${s.count} ("${s.label}") for planned run "${s.run}"${s.date ? ` on ${s.date}` : ""}`;
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
    visible,
    route,
    note,
    suggestion,
  } = input;
  if (!name) return null;

  const kind = activityType ? `${activityType} activity` : "activity";
  const parts: string[] = note ? [note] : [];
  parts.push(
    route
      ? `Viewing the map for stored route "${name}" (route_id ${route.routeId}), version ${route.version} of ${route.latestVersion}.`
      : suggestion
        ? `Viewing the map for ${suggestionPhrase(suggestion)}.`
        : `Viewing the map for ${kind} "${name}".`,
  );

  if (hasGeometry) {
    parts.push(`Distance ${distanceKm.toFixed(1)} km.`);
    if (elevationGain > 0) {
      parts.push(`Elevation gain ${Math.round(elevationGain)} m.`);
    }
    if (route) {
      parts.push(
        `It has ${route.sectionCount === 1 ? "1 section" : `${route.sectionCount} sections`}.`,
      );
      if (route.compare) parts.push(route.compare);
    } else if (colorMetric && !suggestion) {
      parts.push(`The track is coloured by ${colorMetric.toLowerCase()}.`);
    }
    if (visible) parts.push(`${visible}.`);
  } else {
    parts.push("No GPS track is available for it.");
  }

  return parts.join(" ");
}
