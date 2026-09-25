import { z } from "zod";
import {
  HttpError,
  NotPortedError,
  RateLimitError,
  stravaApi,
} from "./fetchClient";

/**
 * Retired transitional client, pending the Phase 1/2 intervals.icu port.
 *
 * Every function here still takes an `accessToken` parameter (validated, so
 * a caller mistake still surfaces immediately) but sends no `Authorization`
 * header on any request: the credential configured on this server is an
 * intervals.icu API key, and forwarding it to Strava would leak a full
 * read/write credential to a third party. Every call below therefore fails
 * with a 401, translated by {@link handleApiError} into a message naming the
 * tool as not yet ported.
 */

/**
 * Strava resource identifier (activity, segment, segment-effort, athlete, etc.).
 *
 * Strava issues 64-bit ids; segment-effort ids in particular now exceed
 * `Number.MAX_SAFE_INTEGER`, which both loses precision under the default JSON
 * parse and trips `z.number().int()`'s safe-integer bound. The fetch client
 * preserves oversized integers as exact strings (see `parseJsonWithLargeInts`);
 * here we accept a number, bigint, or string and normalise to a string so ids
 * round-trip losslessly and never blow up validation.
 */
const StravaIdSchema = z
  .union([z.number(), z.bigint(), z.string()])
  .transform((value) => value.toString());

// SummaryActivity schema based on Strava Swagger spec
// Uses .passthrough() so Zod doesn't strip unrecognized fields
const StravaActivitySchema = z
  .object({
    id: StravaIdSchema,
    resource_state: z.number().int().optional(),
    athlete: z
      .object({ id: StravaIdSchema, resource_state: z.number().int() })
      .optional(),
    name: z.string(),
    distance: z.number(),
    moving_time: z.number().int().optional(),
    elapsed_time: z.number().int().optional(),
    total_elevation_gain: z.number().optional(),
    type: z.string().optional(),
    sport_type: z.string().optional(),
    workout_type: z.number().int().optional().nullable(),
    external_id: z.string().optional().nullable(),
    upload_id: StravaIdSchema.optional().nullable(),
    start_date: z.string().datetime(),
    start_date_local: z.string().datetime().optional(),
    timezone: z.string().optional(),
    utc_offset: z.number().optional(),
    start_latlng: z.array(z.number()).optional().nullable(),
    end_latlng: z.array(z.number()).optional().nullable(),
    achievement_count: z.number().int().optional(),
    kudos_count: z.number().int().optional(),
    comment_count: z.number().int().optional(),
    athlete_count: z.number().int().optional(),
    photo_count: z.number().int().optional(),
    map: z
      .object({
        id: z.string(),
        summary_polyline: z.string().optional().nullable(),
        resource_state: z.number().int(),
      })
      .nullable()
      .optional(),
    trainer: z.boolean().optional(),
    commute: z.boolean().optional(),
    manual: z.boolean().optional(),
    private: z.boolean().optional(),
    flagged: z.boolean().optional(),
    gear_id: z.string().optional().nullable(),
    from_accepted_tag: z.boolean().optional(),
    average_speed: z.number().optional(),
    max_speed: z.number().optional(),
    average_cadence: z.number().optional().nullable(),
    average_watts: z.number().optional().nullable(),
    weighted_average_watts: z.number().int().optional().nullable(),
    kilojoules: z.number().optional().nullable(),
    device_watts: z.boolean().optional().nullable(),
    has_heartrate: z.boolean().optional(),
    average_heartrate: z.number().optional().nullable(),
    max_heartrate: z.number().optional().nullable(),
    max_watts: z.number().int().optional().nullable(),
    elev_high: z.number().optional().nullable(),
    elev_low: z.number().optional().nullable(),
    pr_count: z.number().int().optional(),
    total_photo_count: z.number().int().optional(),
    has_kudoed: z.boolean().optional(),
    suffer_score: z.number().optional().nullable(),
    device_name: z.string().optional().nullable(),
  })
  .passthrough();

export type StravaSummaryActivity = z.infer<typeof StravaActivitySchema>;

// Define the expected response structure for the activities endpoint
const StravaActivitiesResponseSchema = z.array(StravaActivitySchema);

// Define the expected structure for the Authenticated Athlete response
const BaseAthleteSchema = z.object({
  id: StravaIdSchema,
  resource_state: z.number().int(),
});

// --- Athlete Gear (summary) Schema ---
// Gear as it appears in the shoes/bikes arrays on the detailed athlete profile.
const AthleteGearSchema = z.object({
  id: z.string(),
  resource_state: z.number().int().optional(),
  primary: z.boolean(),
  name: z.string(),
  nickname: z.string().nullable().optional(),
  retired: z.boolean().optional(),
  distance: z.number(),
});

const DetailedAthleteSchema = BaseAthleteSchema.extend({
  username: z.string().nullable(),
  firstname: z.string(),
  lastname: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  sex: z.enum(["M", "F"]).nullable(),
  premium: z.boolean(),
  summit: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  profile_medium: z.string().url(),
  profile: z.string().url(),
  weight: z.number().nullable(),
  measurement_preference: z.enum(["feet", "meters"]).optional().nullable(),
  /** Functional threshold power in watts; the IF denominator when set. */
  ftp: z.number().nullable().optional(),
  // Add other fields as needed (e.g., follower_count, friend_count, clubs)
  shoes: z.array(AthleteGearSchema).optional(),
  bikes: z.array(AthleteGearSchema).optional(),
});

// --- Stats Schemas ---
// Schema for individual activity totals (like runs, rides, swims)
const ActivityTotalSchema = z.object({
  count: z.number().int(),
  distance: z.number(), // In meters
  moving_time: z.number().int(), // In seconds
  elapsed_time: z.number().int(), // In seconds
  elevation_gain: z.number(), // In meters
  achievement_count: z.number().int().optional().nullable(), // Optional based on Strava docs examples
});

// Schema for the overall athlete stats response
const ActivityStatsSchema = z.object({
  biggest_ride_distance: z.number().optional().nullable(),
  biggest_climb_elevation_gain: z.number().optional().nullable(),
  recent_ride_totals: ActivityTotalSchema,
  recent_run_totals: ActivityTotalSchema,
  recent_swim_totals: ActivityTotalSchema,
  ytd_ride_totals: ActivityTotalSchema,
  ytd_run_totals: ActivityTotalSchema,
  ytd_swim_totals: ActivityTotalSchema,
  all_ride_totals: ActivityTotalSchema,
  all_run_totals: ActivityTotalSchema,
  all_swim_totals: ActivityTotalSchema,
});

// --- Gear Schema ---
const SummaryGearSchema = z
  .object({
    id: z.string(),
    resource_state: z.number().int(),
    primary: z.boolean(),
    name: z.string(),
    distance: z.number(), // Distance in meters for the gear
  })
  .nullable()
  .optional(); // Activity might not have gear or it might be null

// --- Map Schema ---
const MapSchema = z
  .object({
    id: z.string(),
    // Detailed resources (activity, route) also carry the full-resolution
    // `polyline`; summaries only carry `summary_polyline`. Both are Google
    // encoded-polyline strings — see apps/server/src/polyline.ts.
    polyline: z.string().optional().nullable(),
    summary_polyline: z.string().optional().nullable(),
    resource_state: z.number().int(),
  })
  .nullable(); // Activity might not have a map

// --- Segment Schema ---
const SummarySegmentSchema = z.object({
  id: StravaIdSchema,
  name: z.string(),
  activity_type: z.string(),
  distance: z.number(),
  average_grade: z.number(),
  maximum_grade: z.number(),
  elevation_high: z.number().optional().nullable(),
  elevation_low: z.number().optional().nullable(),
  start_latlng: z.array(z.number()).optional().nullable(),
  end_latlng: z.array(z.number()).optional().nullable(),
  climb_category: z.number().int().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  private: z.boolean().optional(),
  starred: z.boolean().optional(),
});

// --- Detailed Activity Schema ---
// Based on https://developers.strava.com/docs/reference/#api-models-DetailedActivity
const DetailedActivitySchema = z.object({
  id: StravaIdSchema,
  resource_state: z.number().int(), // Should be 3 for detailed
  athlete: BaseAthleteSchema, // Contains athlete ID
  name: z.string(),
  distance: z.number().optional(), // Optional for stationary activities
  moving_time: z.number().int().optional(),
  elapsed_time: z.number().int(),
  total_elevation_gain: z.number().optional(),
  type: z.string(), // e.g., "Run", "Ride"
  sport_type: z.string(),
  start_date: z.string().datetime(),
  start_date_local: z.string().datetime(),
  timezone: z.string(),
  start_latlng: z.array(z.number()).nullable(),
  end_latlng: z.array(z.number()).nullable(),
  achievement_count: z.number().int().optional(),
  kudos_count: z.number().int(),
  comment_count: z.number().int(),
  athlete_count: z.number().int().optional(), // Number of athletes on the activity
  photo_count: z.number().int(),
  map: MapSchema,
  trainer: z.boolean(),
  commute: z.boolean(),
  manual: z.boolean(),
  private: z.boolean(),
  flagged: z.boolean(),
  gear_id: z.string().nullable(), // ID of the gear used
  average_speed: z.number().optional(),
  max_speed: z.number().optional(),
  average_cadence: z.number().optional().nullable(),
  average_temp: z.number().int().optional().nullable(),
  average_watts: z.number().optional().nullable(), // Rides only
  max_watts: z.number().int().optional().nullable(), // Rides only
  weighted_average_watts: z.number().int().optional().nullable(), // Rides only
  kilojoules: z.number().optional().nullable(), // Rides only
  device_watts: z.boolean().optional().nullable(), // Rides only
  has_heartrate: z.boolean(),
  average_heartrate: z.number().optional().nullable(),
  max_heartrate: z.number().optional().nullable(),
  calories: z.number().optional(),
  description: z.string().nullable(),
  // photos: // Add PhotosSummary schema if needed
  gear: SummaryGearSchema,
  device_name: z.string().optional().nullable(),
  // segment_efforts: // Add DetailedSegmentEffort schema if needed
  // splits_metric: // Add Split schema if needed
  // splits_standard: // Add Split schema if needed
  // laps: // Add Lap schema if needed
});

// --- Meta Schemas ---
// Based on https://developers.strava.com/docs/reference/#api-models-MetaActivity
const MetaActivitySchema = z.object({
  id: StravaIdSchema,
});

// BaseAthleteSchema serves as MetaAthleteSchema (id only needed for effort)

// --- Segment Effort Schema ---
// Based on https://developers.strava.com/docs/reference/#api-models-DetailedSegmentEffort
const DetailedSegmentEffortSchema = z.object({
  id: StravaIdSchema,
  activity: MetaActivitySchema,
  athlete: BaseAthleteSchema,
  segment: SummarySegmentSchema, // Reuse SummarySegmentSchema
  name: z.string(), // Segment name
  elapsed_time: z.number().int(), // seconds
  moving_time: z.number().int(), // seconds
  start_date: z.string().datetime(),
  start_date_local: z.string().datetime(),
  distance: z.number(), // meters
  start_index: z.number().int().optional().nullable(),
  end_index: z.number().int().optional().nullable(),
  average_cadence: z.number().optional().nullable(),
  device_watts: z.boolean().optional().nullable(),
  average_watts: z.number().optional().nullable(),
  average_heartrate: z.number().optional().nullable(),
  max_heartrate: z.number().optional().nullable(),
  kom_rank: z.number().int().optional().nullable(), // 1-10, null if not in top 10
  pr_rank: z.number().int().optional().nullable(), // 1, 2, 3, or null
  hidden: z.boolean().optional().nullable(),
});

// Extend DetailedActivitySchema to include segment_efforts now that the schema is defined
const ExtendedDetailedActivitySchema = DetailedActivitySchema.extend({
  segment_efforts: z.array(DetailedSegmentEffortSchema).optional(),
});
export type StravaDetailedActivity = z.infer<
  typeof ExtendedDetailedActivitySchema
>;

// --- Schema Exports for Testing ---
export {
  ActivityStatsSchema,
  AthleteGearSchema,
  DetailedAthleteSchema,
  ExtendedDetailedActivitySchema as DetailedActivitySchema,
  SummarySegmentSchema,
};

/**
 * A Strava API failure that {@link handleApiError} has already interpreted:
 * the user-facing message, with the HTTP status still attached.
 *
 * It extends {@link HttpError} so the status survives the translation. Never
 * flatten a failure into a plain `Error` here: a caller that degrades on one
 * specific status (the streams fetcher treats a 404 as "this activity has
 * no recorded samples" and anything else as a real failure) then has
 * nothing to test `instanceof` against, its branch silently never runs, and
 * the 404 surfaces as a raw API error. Degrading on a status is only
 * expressible if the status is still there.
 */
export class StravaApiError extends HttpError {
  constructor(
    message: string,
    response: { status: number; statusText: string; data: string },
  ) {
    super(message, response);
    this.name = "StravaApiError";
  }
}

/**
 * Helper function to handle API errors
 * @param error - The caught error
 * @param context - The context in which the error occurred
 * @returns Never returns normally, always throws an error
 */
async function handleApiError<T>(error: unknown, context: string): Promise<T> {
  // Check if it's a fetch error with response data
  const isHttpError = error instanceof HttpError;
  const status = isHttpError ? error.response.status : undefined;

  // Every request through this client sends no Authorization header (see the
  // module comment), so Strava always answers 401. That is expected: this
  // tool has not been ported to intervals.icu yet. Thrown as NotPortedError,
  // not StravaApiError, so tools/_errors.ts can tell this apart from
  // intervals.icu itself rejecting an API key (also a 401) without
  // string-matching the message.
  if (isHttpError && status === 401) {
    throw new NotPortedError(
      `${context}: this tool still uses the retired Strava client and has not been ported to intervals.icu yet.`,
      error.response,
    );
  }

  // Rate limit exhausted (429). The fetch layer has already honoured any
  // Retry-After and retried where it could; by the time it surfaces here the
  // window is genuinely exhausted. Return a structured, actionable message
  // (which window, when it resets) instead of the raw "Strava API Error (429)".
  if (error instanceof RateLimitError) {
    console.error(`⏳ Strava rate limit hit in ${context}: ${error.message}`);
    // Rethrown typed, not as a plain `Error`: `get-best-efforts` and
    // `get-race-prediction` stop their scans on `instanceof RateLimitError`,
    // and flattening it here left that predicate permanently false — the pool
    // kept spending an exhausted quota, and every activity it could not read
    // was reported as a failed fetch rather than as skipped. The message is
    // unchanged; only the type it arrives as is.
    throw new RateLimitError(
      `Strava rate limit exceeded in ${context}. ${error.message}`,
      error.response,
      error.rateLimit,
      error.retryAfterSeconds,
      error.detail,
    );
  }

  // Check for subscription error (402)
  if (isHttpError && status === 402) {
    console.error(`🔒 Subscription Required in ${context}. Status: 402`);
    // Throw a specific error type or use a unique message
    throw new StravaApiError(
      `SUBSCRIPTION_REQUIRED: Access to this feature requires a Strava subscription. Context: ${context}`,
      error.response,
    );
  }

  // Standard error handling
  if (isHttpError) {
    const responseData = error.response.data;
    let message = error.message;
    try {
      const parsed: unknown = JSON.parse(responseData);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof (parsed as { message: unknown }).message === "string"
      ) {
        message = (parsed as { message: string }).message;
      }
    } catch {
      // responseData is not JSON, use error.message
    }
    console.error(
      `Strava API request failed in ${context} with status ${status}: ${message}`,
    );
    if (responseData) {
      console.error(`Response data (${context}):`, responseData);
    }
    throw new StravaApiError(
      `Strava API Error in ${context} (${status}): ${message}`,
      error.response,
    );
  }
  if (error instanceof Error) {
    console.error(`An unexpected error occurred in ${context}:`, error);
    throw new Error(
      `An unexpected error occurred in ${context}: ${error.message}`,
    );
  }
  console.error(`An unknown error object was caught in ${context}:`, error);
  throw new Error(`An unknown error occurred in ${context}: ${String(error)}`);
}

/**
 * Fetches all activities for the authenticated athlete with pagination and date filtering.
 * Automatically handles multiple pages to retrieve complete activity history.
 *
 * @param accessToken - The Strava API access token.
 * @param params - Parameters for filtering and pagination.
 * @returns A promise that resolves to an array of all matching Strava activities.
 * @throws Throws an error if the API request fails or the response format is unexpected.
 */
export async function getAllActivities(
  accessToken: string,
  params: GetAllActivitiesParams = {},
): Promise<StravaSummaryActivity[]> {
  if (!accessToken) {
    throw new Error("Strava access token is required.");
  }

  const {
    page = 1,
    perPage = 200, // Max allowed by Strava
    before,
    after,
    onProgress,
    maxItems,
    countActivity,
  } = params;

  const allActivities: StravaSummaryActivity[] = [];
  let currentPage = page;
  let hasMore = true;
  let matchedCount = 0;

  try {
    while (hasMore) {
      // Build query parameters
      const queryParams: Record<string, string | number | boolean> = {
        page: currentPage,
        per_page: perPage,
      };

      // Add date filters if provided
      if (before !== undefined) queryParams.before = before;
      if (after !== undefined) queryParams.after = after;

      // Fetch current page
      const response = await stravaApi.get<unknown>("/athlete/activities", {
        params: queryParams,
      });

      const validationResult = StravaActivitiesResponseSchema.safeParse(
        response.data,
      );

      if (!validationResult.success) {
        console.error(
          `Strava API response validation failed (getAllActivities page ${currentPage}):`,
          validationResult.error,
        );
        throw new Error(
          `Invalid data format received from Strava API: ${validationResult.error.message}`,
        );
      }

      const activities = validationResult.data;

      // Add activities to collection
      allActivities.push(...activities);
      matchedCount += countActivity
        ? activities.filter(countActivity).length
        : activities.length;

      // Report progress if callback provided
      if (onProgress) {
        onProgress(allActivities.length, currentPage);
      }

      // Check if we should continue
      // Stop if we got fewer activities than requested (indicating last page)
      // or once the caller's cap is satisfied.
      hasMore =
        activities.length === perPage &&
        (maxItems === undefined || matchedCount < maxItems);
      currentPage += 1;

      // Add a small delay to be respectful of rate limits
      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return allActivities;
  } catch (error) {
    return await handleApiError<StravaSummaryActivity[]>(
      error,
      "getAllActivities",
    );
  }
}

/**
 * Fetches detailed information for a specific activity by its ID.
 *
 * @param accessToken - The Strava API access token.
 * @param activityId - The ID of the activity to fetch.
 * @param options - `skipCache: true` forces a fresh fetch, bypassing the
 *   response cache (used by write paths that must read current state).
 * @returns A promise that resolves to the detailed activity data.
 * @throws Throws an error if the API request fails or the response format is unexpected.
 */
export async function getActivityById(
  accessToken: string,
  activityId: number | string,
  options: { skipCache?: boolean } = {},
): Promise<StravaDetailedActivity> {
  if (!accessToken) {
    throw new Error("Strava access token is required.");
  }
  if (!activityId) {
    throw new Error("Activity ID is required to fetch details.");
  }

  try {
    const response = await stravaApi.get<unknown>(`/activities/${activityId}`, {
      skipCache: options.skipCache,
    });

    const validationResult = ExtendedDetailedActivitySchema.safeParse(
      response.data,
    );

    if (!validationResult.success) {
      console.error(
        `Strava API validation failed (getActivityById: ${activityId}):`,
        validationResult.error,
      );
      throw new Error(
        `Invalid data format received from Strava API: ${validationResult.error.message}`,
      );
    }
    return validationResult.data;
  } catch (error) {
    return await handleApiError<StravaDetailedActivity>(
      error,
      `getActivityById for ID ${activityId}`,
    );
  }
}

/** What a stream set can be attached to. */
export type StreamResourceKind = "activity";

/**
 * The resource genuinely has no recorded samples: Strava answered 404, or
 * returned an empty stream set. Distinct from every other failure so callers
 * can degrade (a manual activity really has nothing to analyse) without also
 * swallowing an expired token or an exhausted rate limit.
 */
export class StreamsUnavailableError extends Error {
  resourceId: string;
  kind: StreamResourceKind;

  constructor(
    resourceId: number | string,
    kind: StreamResourceKind = "activity",
  ) {
    super(`No data streams are recorded for ${kind} ${resourceId}.`);
    this.name = "StreamsUnavailableError";
    this.resourceId = String(resourceId);
    this.kind = kind;
  }
}

/** Strava's stream response: one entry per requested type. */
const StravaStreamSetSchema = z.array(
  z.object({ type: z.string(), data: z.array(z.unknown()) }).loose(),
);

/** Requested stream type → its raw sample array. */
export type StravaStreamSet = Map<string, unknown[]>;

/**
 * Fetches an activity's data streams.
 *
 * This is the single stream-fetch path: never reach for `stravaApi.get()`
 * directly behind a bare `catch {}`. That gives neither a 401 nor a 429 a
 * structured message, and surfaces both to the athlete as "this activity has
 * no samples", which is wrong and hides the one-line fix. Only a
 * genuine 404 or empty response yields {@link StreamsUnavailableError}; auth,
 * rate-limit, and subscription failures go through {@link handleApiError} like
 * every other client call.
 *
 * @param accessToken - The Strava API access token.
 * @param activityId - The activity whose streams to fetch.
 * @param types - Stream keys to request (e.g. `["time", "heartrate"]`).
 * @param options - `series_type` / `resolution` query parameters.
 * @throws {StreamsUnavailableError} when the activity has no recorded samples.
 */
export async function getActivityStreams(
  accessToken: string,
  activityId: number | string,
  types: readonly string[],
  options: {
    seriesType?: "time" | "distance";
    resolution?: "low" | "medium" | "high";
  } = {},
): Promise<StravaStreamSet> {
  if (!accessToken) {
    throw new Error("Strava access token is required.");
  }
  if (!activityId) {
    throw new Error("Activity ID is required to fetch streams.");
  }

  const query = new URLSearchParams();
  if (options.seriesType) query.set("series_type", options.seriesType);
  if (options.resolution) query.set("resolution", options.resolution);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return fetchStreamSet({
    accessToken,
    endpoint: `/activities/${activityId}/streams/${types.join(",")}${suffix}`,
    kind: "activity",
    resourceId: activityId,
    context: `getActivityStreams for ID ${activityId}`,
  });
}

/**
 * The one place a stream set is fetched, validated, and error-mapped, for
 * activities. Every caller inherits the same
 * contract: a genuine 404 or an empty response is
 * {@link StreamsUnavailableError} — the single failure a caller may degrade
 * on — while auth, rate-limit, and subscription failures go through
 * {@link handleApiError} so a 429 gets the structured message.
 */
async function fetchStreamSet(args: {
  accessToken: string;
  endpoint: string;
  kind: StreamResourceKind;
  resourceId: number | string;
  context: string;
}): Promise<StravaStreamSet> {
  const { endpoint, kind, resourceId, context } = args;
  try {
    const response = await stravaApi.get<unknown>(endpoint);

    const validationResult = StravaStreamSetSchema.safeParse(response.data);
    if (!validationResult.success) {
      console.error(
        `Strava API validation failed (${context}):`,
        validationResult.error,
      );
      throw new Error(
        `Invalid data format received from Strava API: ${validationResult.error.message}`,
      );
    }
    if (validationResult.data.length === 0) {
      throw new StreamsUnavailableError(resourceId, kind);
    }

    return new Map(validationResult.data.map((s) => [s.type, s.data]));
  } catch (error) {
    if (error instanceof StreamsUnavailableError) {
      throw error;
    }
    // Strava answers 404 for a resource that recorded nothing (a manual
    // activity, a route saved before it stored a profile). That is the only
    // status that means "no samples" — everything else is a real failure and
    // must not be reported as an empty resource.
    if (error instanceof HttpError && error.response.status === 404) {
      throw new StreamsUnavailableError(resourceId, kind);
    }
    return await handleApiError<StravaStreamSet>(error, context);
  }
}

// Interface for getAllActivities parameters
export interface GetAllActivitiesParams {
  page?: number;
  perPage?: number;
  before?: number; // epoch timestamp in seconds
  after?: number; // epoch timestamp in seconds
  onProgress?: (fetched: number, page: number) => void;
  /**
   * Stop paginating once at least this many activities have been collected.
   * The page that satisfies the cap is returned in full (no trimming), so
   * callers apply their own final slice.
   */
  maxItems?: number;
  /**
   * Which activities count toward `maxItems` (default: all). Lets callers
   * that post-filter (e.g. runs only) keep paginating until enough matching
   * activities have arrived without fetching the whole history.
   */
  countActivity?: (activity: StravaSummaryActivity) => boolean;
}

// --- Lap Schema ---
// Based on https://developers.strava.com/docs/reference/#api-models-Lap and user-provided image
const LapSchema = z.object({
  id: StravaIdSchema,
  resource_state: z.number().int(),
  name: z.string(),
  activity: BaseAthleteSchema, // Reusing BaseAthleteSchema for {id, resource_state}
  athlete: BaseAthleteSchema, // Reusing BaseAthleteSchema for {id, resource_state}
  elapsed_time: z.number().int(), // In seconds
  moving_time: z.number().int(), // In seconds
  start_date: z.string().datetime(),
  start_date_local: z.string().datetime(),
  distance: z.number(), // In meters
  start_index: z.number().int().optional().nullable(), // Index in the activity stream
  end_index: z.number().int().optional().nullable(), // Index in the activity stream
  total_elevation_gain: z.number().optional().nullable(), // In meters
  average_speed: z.number().optional().nullable(), // In meters per second
  max_speed: z.number().optional().nullable(), // In meters per second
  average_cadence: z.number().optional().nullable(), // RPM
  average_watts: z.number().optional().nullable(), // Rides only
  device_watts: z.boolean().optional().nullable(), // Whether power sensor was used
  average_heartrate: z.number().optional().nullable(), // Average heart rate during lap
  max_heartrate: z.number().optional().nullable(), // Max heart rate during lap
  lap_index: z.number().int(), // The position of this lap in the activity
  split: z.number().int().optional().nullable(), // Associated split number (e.g., for marathons)
});

export type StravaLap = z.infer<typeof LapSchema>;
const StravaLapsResponseSchema = z.array(LapSchema);

/**
 * Retrieves the laps for a specific activity.
 * @param accessToken The Strava API access token.
 * @param activityId The ID of the activity.
 * @returns A promise resolving to an array of lap objects.
 */
export async function getActivityLaps(
  accessToken: string,
  activityId: number | string,
): Promise<StravaLap[]> {
  if (!accessToken) {
    throw new Error("Strava access token is required.");
  }

  try {
    const response = await stravaApi.get(`/activities/${activityId}/laps`);

    const validationResult = StravaLapsResponseSchema.safeParse(response.data);

    if (!validationResult.success) {
      console.error(
        `Strava API validation failed (getActivityLaps: ${activityId}):`,
        validationResult.error,
      );
      throw new Error(
        `Invalid data format received from Strava API: ${validationResult.error.message}`,
      );
    }

    return validationResult.data;
  } catch (error) {
    return await handleApiError<StravaLap[]>(
      error,
      `getActivityLaps(${activityId})`,
    );
  }
}
