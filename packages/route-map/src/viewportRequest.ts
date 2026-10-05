/**
 * Validating a `set-viewport` call, independent of which view will act on it.
 *
 * The SVG grid frames a stretch by moving its viewBox, the basemap by moving
 * the MapLibre camera; both answer the same requests with the same words. So
 * the checks that depend only on the arguments and the distance stream live
 * here, and the component picks the view to move. The one check that depends
 * on view state (no projected geometry) stays in the component.
 */

import { type IndexRange, indexRangeForDistance } from "./viewport";

export type ViewportRequest =
  | { kind: "reset" }
  | { kind: "range"; range: IndexRange; fromKm: number; toKm: number }
  | { kind: "error"; text: string };

/**
 * Resolve `set-viewport` arguments against the route's cumulative distance
 * stream (metres). `routeKm` is the route length the replies quote; it
 * defaults to the stream's last sample, and the component passes the
 * activity's own distance so the reply matches the rest of the card.
 */
export function resolveViewportRequest(
  args: { fromKm?: unknown; toKm?: unknown; reset?: unknown },
  distance: readonly number[] | undefined,
  routeKm = (distance?.at(-1) ?? 0) / 1000,
): ViewportRequest {
  if (args.reset === true) return { kind: "reset" };

  if (!distance || distance.length === 0) {
    // A track can have coordinates but no distance stream (the server
    // didn't get one back), so there is nothing to measure a kilometre
    // against. Say that rather than guess a position from the point
    // index, which is only right at constant speed.
    return {
      kind: "error",
      text: "This track has no recorded distances, so the map cannot be positioned by kilometre. Ask to reset the view instead.",
    };
  }

  const fromKm = typeof args.fromKm === "number" ? args.fromKm : 0;
  const toKm = typeof args.toKm === "number" ? args.toKm : routeKm;
  const range = indexRangeForDistance(distance, fromKm * 1000, toKm * 1000);
  if (!range) {
    return {
      kind: "error",
      text: `That stretch is not on this route, which is ${routeKm.toFixed(1)} km long.`,
    };
  }
  return { kind: "range", range, fromKm, toKm: Math.min(toKm, routeKm) };
}
