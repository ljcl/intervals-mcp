import {
  ACTIVITY_ID1_ARG_KEYS,
  ACTIVITY_ID2_ARG_KEYS,
  toolArgId,
  toolArgRecord,
} from "@intervals-mcp/ui";

/** The app's arguments, normalised from the host's raw tool arguments. */
export interface ToolArgs {
  activityId1: string;
  activityId2: string;
}

/**
 * Host tool arguments are the model's raw arguments, so every spelling of
 * each slot the server accepts is read too. Null unless both ids are
 * there: the root then shows the missing-ids error.
 */
export function parseToolArgs(raw: unknown): ToolArgs | null {
  const args = toolArgRecord(raw);
  const activityId1 = toolArgId(args, ...ACTIVITY_ID1_ARG_KEYS);
  const activityId2 = toolArgId(args, ...ACTIVITY_ID2_ARG_KEYS);
  return activityId1 === null || activityId2 === null
    ? null
    : { activityId1, activityId2 };
}
