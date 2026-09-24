import { type StravaDetailedActivity } from "./stravaClient";
import { isRunningActivity } from "./utils/running";

/**
 * One segment effort flattened for the activity-segments app. Mirrors
 * `SegmentEffortRow` in `@intervals-mcp/activity-segments/src/types.ts`; grade and
 * climb category come from the nested segment, the rest from the effort itself.
 */
export interface ActivitySegmentRow {
  name: string;
  segmentId: string;
  /**
   * The effort's own id, distinct from the segment's. Exposed so the model can
   * chain straight from a row into `compare-segment-efforts` instead of
   * having to re-derive it from the activity.
   */
  effortId: string;
  distanceMeters: number;
  elapsedTime: number;
  movingTime: number;
  averageGrade: number;
  maximumGrade: number;
  climbCategory: number | null;
  prRank: number | null;
  komRank: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averageWatts: number | null;
  deviceWatts: boolean | null;
  averageCadence: number | null;
  startIndex: number | null;
}

/** Payload returned by `get-activity-segments-data` and parsed by the app. */
export interface ActivitySegmentsData {
  id: string;
  name: string;
  activityType: string | null;
  startDateLocal: string;
  segments: ActivitySegmentRow[];
}

/**
 * Flatten a detailed activity's embedded `segment_efforts` into the app's row
 * shape. No network: the efforts already ride along on the detailed activity.
 * Sorted ascending by `start_index` so segments appear in run order; efforts
 * without a start index sink to the end. Null metrics pass through untouched so
 * the app can render "no data" rather than a misleading zero.
 *
 * Running `averageCadence` is doubled to steps-per-minute here (Strava records
 * running cadence as one-leg strides/min), so the app renders the same `spm`
 * figure as the rest of the codebase. Cycling and other sports stay raw (rpm).
 */
export function mapActivitySegments(
  activity: StravaDetailedActivity,
): ActivitySegmentsData {
  const activityType = activity.type ?? activity.sport_type ?? null;
  const doublesCadence = activityType ? isRunningActivity(activityType) : false;
  const efforts = activity.segment_efforts ?? [];
  const segments: ActivitySegmentRow[] = efforts
    .map((e) => ({
      name: e.name,
      segmentId: String(e.segment?.id ?? ""),
      effortId: String(e.id ?? ""),
      distanceMeters: e.distance,
      elapsedTime: e.elapsed_time,
      movingTime: e.moving_time,
      averageGrade: e.segment?.average_grade ?? 0,
      maximumGrade: e.segment?.maximum_grade ?? 0,
      climbCategory: e.segment?.climb_category ?? null,
      prRank: e.pr_rank ?? null,
      komRank: e.kom_rank ?? null,
      averageHeartrate: e.average_heartrate ?? null,
      maxHeartrate: e.max_heartrate ?? null,
      averageWatts: e.average_watts ?? null,
      deviceWatts: e.device_watts ?? null,
      averageCadence:
        e.average_cadence == null
          ? null
          : doublesCadence
            ? e.average_cadence * 2
            : e.average_cadence,
      startIndex: e.start_index ?? null,
    }))
    .sort(
      (a, b) =>
        (a.startIndex ?? Number.POSITIVE_INFINITY) -
        (b.startIndex ?? Number.POSITIVE_INFINITY),
    );

  return {
    id: String(activity.id),
    name: activity.name,
    activityType,
    startDateLocal: activity.start_date_local ?? "",
    segments,
  };
}
