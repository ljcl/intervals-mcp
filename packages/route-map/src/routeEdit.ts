/**
 * Pure parts of the map's route edits: the amend-route operations the
 * controls make, the km along the route nearest a point, how an amend-route
 * result reads, and the texts the chat gets. The React side
 * (`useRouteAmend`) only sends and shows these. Unit-tested.
 */

import { nearestLatLngIndex } from "./basemapData";
import { formatDistanceChange, formatKmRange } from "./routeLayers";
import { type RouteMapData } from "./types";

/** The amend-route operations the map makes (see `amendRoute.ts`). */
export type AmendOperation =
  | { op: "insert_via"; km: number; place: string }
  | { op: "remove_via"; via_id: string }
  | { op: "move_via"; via_id: string; to: string }
  | {
      op: "replace_section";
      from_km: number;
      to_km: number;
      through?: string;
    };

/** The arguments of one amend-route call. */
export interface AmendRequest {
  route_id: string;
  base_version: number;
  operations: AmendOperation[];
}

/** A point as the "lat,lng" text amend-route takes, to 5 decimals (~1 m). */
export function formatLatLng(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Km along the route at a track index, to 3 decimals; null without distance. */
export function kmAtIndex(data: RouteMapData, index: number): number | null {
  const metres = data.streams?.distance?.[index];
  return metres == null ? null : Math.round(metres) / 1000;
}

/**
 * Km along the route at the track point nearest `[lat, lng]`: where a point
 * put on the map joins the route. Null with no track or no distance stream.
 */
export function nearestRouteKm(
  data: RouteMapData,
  lat: number,
  lng: number,
): number | null {
  const index = nearestLatLngIndex(data.coordinates, lat, lng);
  return index < 0 ? null : kmAtIndex(data, index);
}

/** One line that says what an operation does, for status and chat notes. */
export function describeOperation(op: AmendOperation): string {
  switch (op.op) {
    case "insert_via":
      return `Add a point near km ${op.km.toFixed(1)}`;
    case "remove_via":
      return `Remove point ${op.via_id}`;
    case "move_via":
      return `Move point ${op.via_id}`;
    case "replace_section":
      return `Replace ${formatKmRange(op.from_km, op.to_km)}${op.through ? ` through ${op.through}` : ""}`;
  }
}

/**
 * Text of the server's refusal when a write tool is called through a client
 * on a 2025 protocol revision (claude.ai loads MCP Apps that way). The map
 * then asks the chat to make the change instead.
 */
const LEGACY_REFUSAL_TEXT = "connects with a 2025 protocol revision";

/** Whether an isError text is the server's 2025-revision write refusal. */
export function isLegacyRefusal(text: string): boolean {
  return text.includes(LEGACY_REFUSAL_TEXT);
}

/** The parts of a tool result that `readAmendResult` reads. */
export interface AmendToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/** What one amend-route call did, as the map acts on it. */
export type AmendOutcome =
  | {
      kind: "applied";
      /** The new version, now the latest. */
      version: number;
      /** "Route r1 is now version 4 (3.2–4.8 km changed, +240 m)." */
      summary: string;
      warnings: string[];
    }
  /** Nothing was stored (out of routing budget); `warnings` say why. */
  | { kind: "not_applied"; warnings: string[] }
  /** The server refused the change; `text` is its message. */
  | { kind: "error"; text: string }
  /** This client may not run writes; the chat must make the change. */
  | { kind: "legacy_refused"; text: string };

interface StoredRouteChange {
  distance_change_m: number;
  changed: boolean;
  from_km: number;
  to_km: number;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function isChange(value: unknown): value is StoredRouteChange {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.distance_change_m === "number" &&
    typeof v.from_km === "number" &&
    typeof v.to_km === "number"
  );
}

/** "Route r1 is now version 4 (3.2–4.8 km changed, +240 m)." */
export function appliedSummary(
  routeId: string,
  version: number,
  change: StoredRouteChange | null,
): string {
  if (!change) return `Route ${routeId} is now version ${version}.`;
  const what = change.changed
    ? `${formatKmRange(change.from_km, change.to_km)} changed`
    : "the line is the same";
  return `Route ${routeId} is now version ${version} (${what}, ${formatDistanceChange(change.distance_change_m)}).`;
}

/**
 * Read an amend-route result. An `isError` result is the server's message
 * (its text starts with "❌"), or its refusal to run a write for a 2025
 * client. A success reads `structuredContent` (`StoredRouteOutputSchema`):
 * `applied: false` stored nothing.
 */
export function readAmendResult(
  result: AmendToolResult,
  routeId: string,
): AmendOutcome {
  const text =
    result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
  if (result.isError) {
    if (isLegacyRefusal(text)) return { kind: "legacy_refused", text };
    return { kind: "error", text: text || "❌ amend-route failed." };
  }
  const structured =
    typeof result.structuredContent === "object" &&
    result.structuredContent !== null
      ? (result.structuredContent as Record<string, unknown>)
      : null;
  if (!structured || typeof structured.applied !== "boolean") {
    return {
      kind: "error",
      text: "❌ amend-route sent a result the map cannot read. Open the route again to see its latest version.",
    };
  }
  const warnings = strings(structured.warnings);
  if (!structured.applied) {
    return {
      kind: "not_applied",
      warnings:
        warnings.length > 0
          ? warnings
          : ["No change was made. The version shown is still the latest."],
    };
  }
  const version =
    typeof structured.version === "number" ? structured.version : null;
  if (version === null) {
    return {
      kind: "error",
      text: "❌ amend-route did not say which version it stored. Open the route again to see its latest version.",
    };
  }
  const change = isChange(structured.change) ? structured.change : null;
  return {
    kind: "applied",
    version,
    summary: appliedSummary(routeId, version, change),
    warnings,
  };
}

/** The user message that asks the chat to make the change with amend-route. */
export function fallbackMessage(request: AmendRequest): string {
  return `Please apply this change with amend-route: ${JSON.stringify(request)}`;
}
