import { type ZoneSet } from "@intervals-mcp/data";

// ZoneBucket / ZoneSet are the shared wire types from @intervals-mcp/data, the
// same definitions the server's feed is built from.
export type { ZoneBucket, ZoneSet } from "@intervals-mcp/data";

/** Response from the get-activity-zones-data tool. */
export interface ActivityZonesData {
  activityId: string;
  name: string;
  /** Local start date-time with no offset (`start_date_local`), ISO. */
  date: string;
  type: string;
  zoneSets: ZoneSet[];
  /**
   * Why heart rate zones were dropped, when the server knows: the same
   * string the text tools print. Null otherwise.
   */
  hrZoneWarning: string | null;
}
