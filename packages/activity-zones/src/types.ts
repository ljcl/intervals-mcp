import { type ZoneSet } from "@intervals-mcp/data";

// ZoneBucket / ZoneSet are the shared wire types from @intervals-mcp/data, the
// same definitions the server's feed is built from.
export type { ZoneBucket, ZoneSet } from "@intervals-mcp/data";

/** Response from the get-activity-zones-data tool. */
export interface ActivityZonesData {
  activityId: string;
  name: string;
  /** Local start date, ISO. */
  date: string;
  type: string;
  zoneSets: ZoneSet[];
}
