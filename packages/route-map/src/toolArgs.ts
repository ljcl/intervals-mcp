import { toolArgId, toolArgRecord } from "@intervals-mcp/ui";
import { type ToolArgs, type WaypointArg } from "./types";

/**
 * Host tool arguments are the model's raw arguments, so the legacy
 * `activity_id` is read too. Waypoints pass through for the server to
 * validate and anchor. Null without an id: the root then shows the
 * missing-id error.
 */
export function parseToolArgs(raw: unknown): ToolArgs | null {
  const args = toolArgRecord(raw);
  const id = toolArgId(args, "id", "activity_id");
  if (id === null) return null;
  return Array.isArray(args.waypoints)
    ? { id, waypoints: args.waypoints as WaypointArg[] }
    : { id };
}
