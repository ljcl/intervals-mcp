import { toolArgId, toolArgRecord } from "@intervals-mcp/ui";

/** The app's arguments, normalised from the host's raw tool arguments. */
export interface ToolArgs {
  id: string;
}

/**
 * Host tool arguments are the model's raw arguments, so the legacy
 * `activity_id` is read too. Null without an id: the root then shows the
 * missing-id error.
 */
export function parseToolArgs(raw: unknown): ToolArgs | null {
  const id = toolArgId(toolArgRecord(raw), "id", "activity_id");
  return id === null ? null : { id };
}
