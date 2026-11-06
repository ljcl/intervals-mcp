import { ID_ARG_KEYS, toolArgId, toolArgRecord } from "@intervals-mcp/ui";
import { type AppArgs, type RouteArgs, type WaypointArg } from "./types";

const SUGGESTION_KEYS = [
  "date",
  "distanceKm",
  "start",
  "end",
  "via",
  "shape",
  "terrain",
] as const;

/** Version fields a stored route's map takes, passed through when they are
 * positive whole numbers; the server checks that each one exists. */
const ROUTE_VERSION_KEYS = [
  "version",
  "compare_to_version",
  "waypoints_version",
] as const;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function routeArgs(routeId: string, args: Record<string, unknown>): RouteArgs {
  const out: RouteArgs = { kind: "route", route_id: routeId };
  for (const key of ROUTE_VERSION_KEYS) {
    const value = positiveInt(args[key]);
    if (value !== undefined) out[key] = value;
  }
  if (Array.isArray(args.waypoints))
    out.waypoints = args.waypoints as WaypointArg[];
  return out;
}

/**
 * Host tool arguments are the model's raw arguments, so every id spelling
 * the server accepts is read too. With a `route_id` it is a stored route
 * (its version fields and waypoints pass through); with an id it is the
 * activity map (waypoints pass through); with neither it is
 * view-route-suggestions, whose arguments are all optional, so there is no
 * missing-id case.
 */
export function parseToolArgs(raw: unknown): AppArgs {
  const args = toolArgRecord(raw);
  const routeId = typeof args.route_id === "string" ? args.route_id.trim() : "";
  if (routeId !== "") return routeArgs(routeId, args);
  const id = toolArgId(args, ...ID_ARG_KEYS);
  if (id === null) {
    const passed: Record<string, unknown> = {};
    for (const key of SUGGESTION_KEYS)
      if (args[key] !== undefined) passed[key] = args[key];
    return { kind: "suggestion", args: passed };
  }
  return Array.isArray(args.waypoints)
    ? { id, waypoints: args.waypoints as WaypointArg[] }
    : { id };
}
