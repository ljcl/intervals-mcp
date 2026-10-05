import { toolArgId, toolArgRecord } from "@intervals-mcp/ui";

/** The app's arguments, normalised from the host's raw tool arguments. */
export interface ToolArgs {
  activityId1: string;
  activityId2: string;
}

/**
 * Host tool arguments are the model's raw arguments, so the legacy
 * `activity_id_1`/`activity_id_2` are read too. Null unless both ids are
 * there: the root then shows the missing-ids error.
 */
export function parseToolArgs(raw: unknown): ToolArgs | null {
  const args = toolArgRecord(raw);
  const activityId1 = toolArgId(args, "activityId1", "activity_id_1");
  const activityId2 = toolArgId(args, "activityId2", "activity_id_2");
  return activityId1 === null || activityId2 === null
    ? null
    : { activityId1, activityId2 };
}
