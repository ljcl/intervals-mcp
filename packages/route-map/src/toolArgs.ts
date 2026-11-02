import { ID_ARG_KEYS, toolArgId, toolArgRecord } from "@intervals-mcp/ui";
import { type AppArgs, type WaypointArg } from "./types";

const SUGGESTION_KEYS = [
  "date",
  "distanceKm",
  "start",
  "end",
  "via",
  "shape",
  "terrain",
] as const;

/**
 * Host tool arguments are the model's raw arguments, so every id spelling
 * the server accepts is read too. With an id it is the activity map
 * (waypoints pass through); without one it is view-route-suggestions, whose
 * arguments are all optional, so there is no missing-id case.
 */
export function parseToolArgs(raw: unknown): AppArgs {
  const args = toolArgRecord(raw);
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
