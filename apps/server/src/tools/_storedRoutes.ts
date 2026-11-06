/**
 * What stitch-route, amend-route and export-route share: the route id
 * input, the build env, the result text and its structured form, and the
 * errors the route builder and store raise, as tool results.
 */
import { z } from "zod";
import { getHomeStart, getOrsApiKey } from "../config";
import {
  type BuildEnv,
  RouteBuildError,
  type RouteSummary,
  type VersionChange,
} from "../routeBuilder";
import {
  isRouteId,
  RouteNotFoundError,
  RouteVersionConflictError,
} from "../routeStore";
import { noteToolFailure, prefixedErrorText, toolErrorText } from "./_errors";

export const routeIdInput = (text: string) =>
  z
    .string()
    .trim()
    .refine(isRouteId, {
      message:
        'route_id is the id stitch-route, amend-route or suggest-run-route returned, e.g. "r7k2m9qx4a"',
    })
    .describe(text);

export const placeText = z.string().trim().min(2).max(120);

export const snapInput = z
  .enum(["nearest", "through"])
  .default("nearest")
  .describe(
    "nearest (default): a via meets the route where OpenRouteService snaps it. through: a via the route reaches by a dead end is moved to where the route turns into it, at one more routing call for that section",
  );

export const kmInput = (text: string) =>
  z.number().nonnegative().max(500).describe(text);

/** Config the builder reads, once per call. */
export function routeBuildEnv(): BuildEnv {
  return { orsKey: getOrsApiKey(), homeStart: getHomeStart() };
}

const km = (meters: number) => (meters / 1000).toFixed(2);

const SOURCE_TEXT = {
  recorded: "recorded",
  elevation_model: "elevation model",
  none: "no altitude",
} as const;

/** The structured result of stitch-route and amend-route. */
export function storedRouteStructured(
  summary: RouteSummary,
  extra: {
    applied: boolean;
    created: boolean;
    change: VersionChange | null;
    ors_calls: number;
    warnings?: string[];
  },
) {
  return {
    route_id: summary.route_id,
    name: summary.name,
    version: summary.version,
    latest_version: summary.latest_version,
    applied: extra.applied,
    created: extra.created,
    distance_m: summary.distance_m,
    climb_m: summary.climb_m,
    climb_complete: summary.climb_complete,
    path_share: summary.path_share,
    path_share_coverage: summary.path_share_coverage,
    segments: summary.segments,
    change: extra.change,
    ors_calls: extra.ors_calls,
    warnings: [...(extra.warnings ?? []), ...summary.warnings],
  };
}

export type StoredRouteStructured = ReturnType<typeof storedRouteStructured>;

function sourceText(segment: RouteSummary["segments"][number]): string {
  const { source } = segment;
  if (source.type === "activity") return `activity ${source.activity_id}`;
  if (source.type === "route")
    return `route ${source.route_id} v${source.version}`;
  return source.purpose === "join"
    ? "routed gap"
    : source.purpose === "out_and_back"
      ? "OpenRouteService out-and-back"
      : "OpenRouteService";
}

/** The text of a stored route result: its numbers, sections and via points, never its geometry. */
export function storedRouteLines(result: StoredRouteStructured): string[] {
  const lines: string[] = [];
  // Path share comes from OpenRouteService, so sections from past runs have none.
  const share = `${Math.round((result.path_share ?? 0) * 100)}% on paths`;
  const paths =
    result.path_share === null
      ? "path share unknown (known only for routed sections)"
      : result.path_share_coverage < 1
        ? `path share partial: ${share} over the ${Math.round(result.path_share_coverage * 100)}% of the distance that was routed; unknown for sections from past runs`
        : share;
  lines.push(
    `Route ${result.route_id} version ${result.version} of ${result.latest_version}: "${result.name}"`,
    `Distance ${km(result.distance_m)} km, climb ${result.climb_m} m${result.climb_complete ? "" : " (some sections have no altitude)"}, ${paths}`,
  );
  if (result.change) {
    const c = result.change;
    const sign = c.distance_change_m >= 0 ? "+" : "-";
    lines.push(
      c.changed
        ? `Change from version ${c.from_version}: ${sign}${km(Math.abs(c.distance_change_m))} km; km ${c.from_km.toFixed(2)}-${c.to_km.toFixed(2)} changed (was km ${c.old_from_km.toFixed(2)}-${c.old_to_km.toFixed(2)}).`
        : `Change from version ${c.from_version}: none; the track is the same.`,
    );
  }
  lines.push("Sections:");
  for (const s of result.segments) {
    const climb =
      s.climb_m === null
        ? "climb unknown"
        : `${s.climb_m} m climb (${SOURCE_TEXT[s.climb_source]})`;
    const share =
      s.path_share === null
        ? ""
        : `, ${Math.round(s.path_share * 100)}% on paths`;
    lines.push(
      `${s.index}. km ${s.from_km.toFixed(2)}-${s.to_km.toFixed(2)} ${s.label} [${sourceText(s)}${s.flexible ? ", flexible" : ""}]: ${km(s.distance_m)} km, ${climb}${share}`,
    );
    for (const via of s.vias) {
      // A via shows where it was asked for and where the route meets it, so a wrong match or a far snap is visible.
      const ll = (lat: number, lng: number) =>
        `${lat.toFixed(5)},${lng.toFixed(5)}`;
      const match = via.match_name
        ? `, matched ${via.match_name}, ${via.match_type}`
        : "";
      const where =
        via.kind === "via"
          ? ` (${ll(via.lat, via.lng)}${match}; on the route at ${ll(via.snapped_lat, via.snapped_lng)}, ${via.snap_m} m away${via.moved_m > 0 ? `, moved ${via.moved_m} m by snap through` : ""})`
          : "";
      lines.push(
        `   ${via.kind === "turnaround" ? "Turnaround" : "Via"} ${via.id} at km ${via.km.toFixed(2)}: ${via.label}${where}`,
      );
    }
  }
  if (result.ors_calls > 0)
    lines.push(`Routing calls used: ${result.ors_calls}.`);
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines;
}

/** A builder or store error as a tool result, or null for any other error. */
export function routeErrorResult(error: unknown, context: string) {
  if (
    error instanceof RouteBuildError ||
    error instanceof RouteNotFoundError ||
    error instanceof RouteVersionConflictError
  ) {
    noteToolFailure(error);
    return {
      content: [
        { type: "text" as const, text: prefixedErrorText(error.message) },
      ],
      isError: true as const,
    };
  }
  return {
    content: [
      { type: "text" as const, text: toolErrorText(error, { context }) },
    ],
    isError: true as const,
  };
}
