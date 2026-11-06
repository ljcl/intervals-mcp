/**
 * Pure data for a stored route's map (`source` "route"): the colour of each
 * section, the km markers, the stretch pins, and the text of the version,
 * compare and warning lines. Both views and the legend read these, so the
 * map and the text always agree. Unit-tested; no React, no MapLibre.
 */

import { type SplitMarker, WAYPOINT_COLORS } from "./annotations";
import { type ColorRun } from "./metrics";
import {
  type RouteMapData,
  type RouteMapRoute,
  type WaypointKind,
} from "./types";

/**
 * One colour of the section palette. The SVG view and the legend use the
 * design-system token (`css`), so the host theme applies; the basemap paints
 * on a canvas, which cannot read CSS custom properties, so it uses the
 * light-theme value of the same token (`hex`).
 */
export interface SectionColor {
  css: string;
  hex: string;
}

/** Section colours, in order. Adjacent sections never share a colour. */
export const SECTION_PALETTE: readonly SectionColor[] = [
  { css: "var(--chart-overlay-2)", hex: "#2563eb" },
  { css: "var(--chart-overlay-4)", hex: "#d97706" },
  { css: "var(--chart-overlay-3)", hex: "#16a34a" },
  { css: "var(--chart-power)", hex: "#8b5cf6" },
  { css: "var(--chart-overlay-1)", hex: "#e11d48" },
  { css: "var(--chart-vertical-oscillation)", hex: "#0c9769" },
];

/** Readable names for the section kinds the server sends. */
const KIND_NAMES: Record<string, string> = {
  activity: "past run",
  route: "routed",
  generated: "generated",
  out_and_back: "out and back",
  join: "join",
};

/** A section ready to draw: its index range on the line and its colour. */
export interface SectionRun {
  /** The section's own index, as amend-route and the server name it. */
  index: number;
  startIndex: number;
  endIndex: number;
  color: SectionColor;
  label: string;
  kind: string;
  fromKm: number;
  toKm: number;
}

/**
 * The route's sections as index ranges on `coordinates`, clamped to the
 * track and coloured in palette order. A section with no length on the
 * track still gets a legend entry, but it draws nothing.
 */
export function buildSectionRuns(
  route: RouteMapRoute,
  pointCount: number,
): SectionRun[] {
  if (pointCount === 0) return [];
  const last = pointCount - 1;
  const clamp = (i: number) => Math.min(last, Math.max(0, Math.round(i)));
  return route.segments.map((segment, i) => {
    const startIndex = clamp(segment.startIndex);
    return {
      index: segment.index,
      startIndex,
      endIndex: Math.max(startIndex, clamp(segment.endIndex)),
      color: SECTION_PALETTE[i % SECTION_PALETTE.length]!,
      label: segment.label,
      kind: segment.kind,
      fromKm: segment.from_km,
      toKm: segment.to_km,
    };
  });
}

/** Section runs as basemap colour runs (concrete colours, drawable runs only). */
export function sectionColorRuns(sections: SectionRun[]): ColorRun[] {
  return sections
    .filter((s) => s.endIndex > s.startIndex)
    .map((s) => ({
      startIndex: s.startIndex,
      endIndex: s.endIndex,
      color: s.color.hex,
    }));
}

/** A km range as "3.2–4.8 km". */
export function formatKmRange(fromKm: number, toKm: number): string {
  return `${fromKm.toFixed(1)}–${toKm.toFixed(1)} km`;
}

/** The legend text of one section: its km range, label and kind. */
export function sectionLegendText(section: SectionRun): string {
  const kind = KIND_NAMES[section.kind] ?? section.kind;
  return `${formatKmRange(section.fromKm, section.toKm)} · ${section.label} (${kind})`;
}

/** The route's km markers as split markers ("5 km"). */
export function routeKmMarkers(route: RouteMapRoute): SplitMarker[] {
  return route.kmMarkers.map((marker) => ({
    index: marker.index,
    label: `${marker.km} km`,
  }));
}

/** A stretch pin: a waypoint that covers a part of the line, e.g. a climb. */
export interface StretchMarker {
  startIndex: number;
  endIndex: number;
  kind: WaypointKind;
  color: string;
  title: string;
}

/** Waypoints with an end (`endIndex` after `index`), as stretches to highlight. */
export function buildStretchMarkers(data: RouteMapData): StretchMarker[] {
  const waypoints = data.annotations?.waypoints ?? [];
  return waypoints.flatMap((w) =>
    w.endIndex !== undefined && w.endIndex > w.index
      ? [
          {
            startIndex: w.index,
            endIndex: w.endIndex,
            kind: w.kind,
            color: WAYPOINT_COLORS[w.kind],
            title:
              w.end_km !== undefined
                ? `${w.label} · ${formatKmRange(w.km, w.end_km)}`
                : w.label,
          },
        ]
      : [],
  );
}

/** A signed distance change: "+240 m", "−1.2 km", "no change". */
export function formatDistanceChange(metres: number): string {
  const rounded = Math.round(metres);
  if (rounded === 0) return "no change in distance";
  const sign = rounded > 0 ? "+" : "−";
  const size = Math.abs(rounded);
  return size >= 1000
    ? `${sign}${(size / 1000).toFixed(1)} km`
    : `${sign}${size} m`;
}

/** "Version 3 of 4" and the change that made it, if the server gave one. */
export function versionText(route: RouteMapRoute): {
  title: string;
  change: string | null;
} {
  const change =
    route.versions.find((v) => v.version === route.version)?.change ?? null;
  return {
    title: `Version ${route.version} of ${route.latest_version}`,
    change: change && change.trim() !== "" ? change : null,
  };
}

/**
 * The compare line: which version is drawn under this one, the distance
 * change from the older to the newer, and the km that changed on the shown
 * version. Null without a compare.
 */
export function compareText(route: RouteMapRoute): string | null {
  const compare = route.compare;
  if (!compare) return null;
  const { change } = compare;
  const head = `Compared with version ${compare.version}`;
  if (!change.changed) return `${head}: the line is the same.`;
  const shownIsNewer = route.version > compare.version;
  const range = shownIsNewer
    ? formatKmRange(change.from_km, change.to_km)
    : formatKmRange(change.old_from_km, change.old_to_km);
  return `${head}: version ${change.to_version} is ${formatDistanceChange(change.distance_change_m)} against version ${change.from_version}; ${range} changed.`;
}

/** One warning line, with the km range it applies to when it has one. */
export interface RouteWarning {
  range: string | null;
  text: string;
}

/** Section warnings and waypoint warnings, in one list. */
export function routeWarnings(data: RouteMapData): RouteWarning[] {
  const sections = (data.route?.warnings ?? []).map((w) => ({
    range: formatKmRange(w.from_km, w.to_km),
    text: w.text,
  }));
  const pins = (data.waypointWarnings ?? []).map((text) => ({
    range: null,
    text,
  }));
  return [...sections, ...pins];
}
