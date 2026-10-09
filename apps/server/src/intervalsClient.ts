import { z } from "zod";
import { basicAuthHeader, getIntervalsAthleteId } from "./config";
import {
  HttpError,
  type HttpErrorResponse,
  intervalsApi,
  RateLimitError,
  summarizeErrorBody,
} from "./fetchClient";
import { NO_PROGRESS, type ReportProgress } from "./progress";
import { addDays } from "./utils/localDate";
import { SERVER_VERSION } from "./version";

/**
 * Typed intervals.icu API client for Phase 1 reads.
 *
 * Mirrors the retired Strava client's structure (schemas at the top, a
 * shared `handleApiError`, one function per endpoint) without importing from
 * it: that transitional client sends no `Authorization` header on purpose
 * (see its module comment), which this client must never copy.
 *
 * Every function takes `apiKey` first and sends it as HTTP Basic
 * (`basicAuthHeader`, username `API_KEY`) plus a descriptive `User-Agent`:
 * some clients meet a Cloudflare challenge without one (docs/api-notes.md).
 * Athlete-scoped paths use `getIntervalsAthleteId()`.
 */

/** Loose gear reference as it appears embedded on an activity. */
const IntervalsActivityGearRefSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    distance: z.number().nullable().optional(),
    primary: z.boolean().nullable().optional(),
  })
  .passthrough();

/** One zone's time-in-zone entry within `icu_zone_times` (per the OpenAPI
 * spec's `ZoneTime`: `{ id, secs }`, not a bare number). */
const IntervalsZoneTimeSchema = z
  .object({
    id: z.string().nullable().optional(),
    secs: z.number().nullable().optional(),
  })
  .passthrough();

// --- Interval (within-activity) schema ---
// Declared before the activity schema so a detailed activity's embedded
// `icu_intervals` (present when fetched with `?intervals=true`) can reuse it.
const IntervalsIntervalSchema = z
  .object({
    id: z.number().nullable().optional(),
    type: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    start_index: z.number().nullable().optional(),
    end_index: z.number().nullable().optional(),
    distance: z.number().nullable().optional(),
    moving_time: z.number().nullable().optional(),
    elapsed_time: z.number().nullable().optional(),
    average_heartrate: z.number().nullable().optional(),
    max_heartrate: z.number().nullable().optional(),
    average_cadence: z.number().nullable().optional(),
    average_speed: z.number().nullable().optional(),
    average_stance_time: z.number().nullable().optional(),
    average_vertical_oscillation: z.number().nullable().optional(),
    average_vertical_ratio: z.number().nullable().optional(),
    average_step_length: z.number().nullable().optional(),
    average_stride: z.number().nullable().optional(),
    zone: z.number().nullable().optional(),
    gap: z.number().nullable().optional(),
    total_elevation_gain: z.number().nullable().optional(),
    average_watts: z.number().nullable().optional(),
    average_gradient: z.number().nullable().optional(),
    intensity: z.number().nullable().optional(),
    decoupling: z.number().nullable().optional(),
    group_id: z.string().nullable().optional(),
    start_time: z.number().nullable().optional(),
    end_time: z.number().nullable().optional(),
  })
  .passthrough();

export type IntervalsInterval = z.infer<typeof IntervalsIntervalSchema>;

// --- Activity schema ---
// intervals.icu activities carry hundreds of fields (running dynamics,
// power-meter data, weather, etc.); only the fields a tool reads are typed,
// everything else passes through untouched. Verified against
// __fixtures__/intervals/activity.json and activities.json (2026-09-24).
const IntervalsActivitySchema = z
  .object({
    id: z.string(),
    start_date: z.string().nullable().optional(),
    start_date_local: z.string(),
    type: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    distance: z.number().nullable().optional(),
    moving_time: z.number().nullable().optional(),
    elapsed_time: z.number().nullable().optional(),
    total_elevation_gain: z.number().nullable().optional(),
    gap: z.number().nullable().optional(),
    device_name: z.string().nullable().optional(),
    average_heartrate: z.number().nullable().optional(),
    max_heartrate: z.number().nullable().optional(),
    average_cadence: z.number().nullable().optional(),
    average_weather_temp: z.number().nullable().optional(),
    average_stance_time: z.number().nullable().optional(),
    average_vertical_oscillation: z.number().nullable().optional(),
    average_vertical_ratio: z.number().nullable().optional(),
    average_step_length: z.number().nullable().optional(),
    average_stride: z.number().nullable().optional(),
    icu_hr_zone_times: z.array(z.number()).nullable().optional(),
    pace_zone_times: z.array(z.number()).nullable().optional(),
    gap_zone_times: z.array(z.number()).nullable().optional(),
    icu_training_load: z.number().nullable().optional(),
    hr_load: z.number().nullable().optional(),
    pace_load: z.number().nullable().optional(),
    trimp: z.number().nullable().optional(),
    icu_intensity: z.number().nullable().optional(),
    /** Power-meter load; null on every activity on the account this client
     * was verified against (no power meter, docs/api-notes.md). */
    power_load: z.number().nullable().optional(),
    /** Session RPE (icu_rpe scaled by duration), populated by most uploads. */
    session_rpe: z.number().nullable().optional(),
    /** Present on every activity but observed always null (no power meter,
     * docs/api-notes.md). */
    strain_score: z.number().nullable().optional(),
    decoupling: z.number().nullable().optional(),
    icu_efficiency_factor: z.number().nullable().optional(),
    icu_rpe: z.number().nullable().optional(),
    feel: z.number().nullable().optional(),
    icu_atl: z.number().nullable().optional(),
    icu_ctl: z.number().nullable().optional(),
    icu_athlete_id: z.string().nullable().optional(),
    stream_types: z.array(z.string()).nullable().optional(),
    gear: IntervalsActivityGearRefSchema.nullable().optional(),
    average_speed: z.number().nullable().optional(),
    icu_hr_zones: z.array(z.number()).nullable().optional(),
    /** The athlete's max HR setting when the activity was processed. */
    athlete_max_hr: z.number().nullable().optional(),
    icu_power_zones: z.array(z.number()).nullable().optional(),
    icu_zone_times: z.array(IntervalsZoneTimeSchema).nullable().optional(),
    pace_zones: z.array(z.number()).nullable().optional(),
    race: z.boolean().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    sub_type: z.string().nullable().optional(),
    icu_lap_count: z.number().nullable().optional(),
    /** True when the device's laps were edited/merged in the intervals.icu UI
     * (e.g. the multi-lap fixture: 12 device laps became 18 icu_intervals). */
    icu_intervals_edited: z.boolean().nullable().optional(),
    recording_stops: z.array(z.number()).nullable().optional(),
    icu_warmup_time: z.number().nullable().optional(),
    icu_average_watts: z.number().nullable().optional(),
    icu_ftp: z.number().nullable().optional(),
    /** Only present when fetched via `getActivity(..., { intervals: true })`. */
    icu_intervals: z.array(IntervalsIntervalSchema).optional(),
  })
  .passthrough();

export type IntervalsActivity = z.infer<typeof IntervalsActivitySchema>;
const IntervalsActivitiesResponseSchema = z.array(IntervalsActivitySchema);

const IntervalsIntervalsSchema = z
  .object({
    id: z.string(),
    analyzed: z.string().nullable().optional(),
    icu_intervals: z.array(IntervalsIntervalSchema),
    icu_groups: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type IntervalsIntervals = z.infer<typeof IntervalsIntervalsSchema>;

// --- Stream schema ---
// `latlng` puts latitude in `data` and longitude in `data2`
// (docs/api-notes.md). Samples may be `null` where the sensor dropped out.
const IntervalsStreamSchema = z
  .object({
    type: z.string(),
    data: z.array(z.number().nullable()),
    data2: z.array(z.number().nullable()).nullable().optional(),
  })
  .passthrough();

export type IntervalsStream = z.infer<typeof IntervalsStreamSchema>;
const IntervalsStreamsResponseSchema = z.array(IntervalsStreamSchema);

// --- Gear schema ---
// A reminder's known fields per the intervals.icu OpenAPI spec's
// GearReminder (name, distance in metres, days, percent_used); the real
// account's gear all has `reminders: []`, so this is unverified against a
// live response and deliberately permissive (`.passthrough()`) so an
// unrecognised field is preserved rather than dropped.
const IntervalsGearReminderSchema = z
  .object({
    name: z.string().nullable().optional(),
    distance: z.number().nullable().optional(),
    days: z.number().nullable().optional(),
    percent_used: z.number().nullable().optional(),
  })
  .passthrough();

export type IntervalsGearReminder = z.infer<typeof IntervalsGearReminderSchema>;

const IntervalsGearSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    distance: z.number().nullable().optional(),
    activities: z.number().nullable().optional(),
    // The OpenAPI spec types `retired` as a string (a retirement date); the
    // real account's gear only ever has it `null` (active). Accepting a
    // boolean too is defensive: a strict `z.string()` would throw on any
    // account where the API reports it that way instead.
    retired: z.union([z.string(), z.boolean()]).nullable().optional(),
    reminders: z.array(IntervalsGearReminderSchema).optional(),
  })
  .passthrough();

export type IntervalsGear = z.infer<typeof IntervalsGearSchema>;
const IntervalsGearResponseSchema = z.array(IntervalsGearSchema);

// --- Wellness schema ---
// `id` is the record's date (YYYY-MM-DD). Apple Watch HRV arrives as
// `hrvSDNN`; `hrv` (rMSSD) is null on those devices (docs/api-notes.md).
// `spO2` keeps the API's own capitalisation.
const IntervalsWellnessSchema = z
  .object({
    id: z.string(),
    ctl: z.number().nullable().optional(),
    atl: z.number().nullable().optional(),
    /** That day's load fed into the CTL curve; differs from `atlLoad` on
     * days the account's WeightTraining/Workout activities are excluded
     * from fitness but still count toward fatigue (docs/api-notes.md). */
    ctlLoad: z.number().nullable().optional(),
    /** That day's load fed into the ATL curve (the daily sum of activity
     * `icu_training_load`, docs/api-notes.md). */
    atlLoad: z.number().nullable().optional(),
    rampRate: z.number().nullable().optional(),
    /** Per-sport eFTP snapshot, not a per-sport CTL/ATL (docs/api-notes.md);
     * kept loose since the shape is unconfirmed beyond one observed
     * `{type, eftp, wPrime, pMax}` row and is always null on this account. */
    sportInfo: z.array(z.unknown()).nullable().optional(),
    weight: z.number().nullable().optional(),
    restingHR: z.number().nullable().optional(),
    hrv: z.number().nullable().optional(),
    hrvSDNN: z.number().nullable().optional(),
    sleepSecs: z.number().nullable().optional(),
    sleepScore: z.number().nullable().optional(),
    readiness: z.number().nullable().optional(),
    soreness: z.number().nullable().optional(),
    fatigue: z.number().nullable().optional(),
    stress: z.number().nullable().optional(),
    mood: z.number().nullable().optional(),
    motivation: z.number().nullable().optional(),
    spO2: z.number().nullable().optional(),
    respiration: z.number().nullable().optional(),
    comments: z.string().nullable().optional(),
  })
  .passthrough();

export type IntervalsWellness = z.infer<typeof IntervalsWellnessSchema>;
const IntervalsWellnessResponseSchema = z.array(IntervalsWellnessSchema);

// --- Sport settings schema ---
const IntervalsSportSettingsSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    athlete_id: z.string().nullable().optional(),
    types: z.array(z.string()).optional(),
    /** True on intervals.icu's default group, which covers every type that
     * no other group lists (verified 2026-10-08). */
    other: z.boolean().nullable().optional(),
    lthr: z.number().nullable().optional(),
    max_hr: z.number().nullable().optional(),
    hr_zones: z.array(z.number()).nullable().optional(),
    /** Display only, so a bad value never fails the whole parse (and with it
     * every caller of the settings): a null name stays null, and any other
     * bad value gives null. The same for `pace_units` and `pace_zone_names`. */
    hr_zone_names: z
      .array(z.string().nullable())
      .nullable()
      .optional()
      .catch(null),
    /** A speed in m/s, not a pace (verified 2026-10-08). */
    threshold_pace: z.number().nullable().optional(),
    /** A display setting only: MINS_KM, SECS_100M, ... */
    pace_units: z.string().nullable().optional().catch(null),
    /** Ascending percentages of threshold speed; 999 is the open top. */
    pace_zones: z.array(z.number()).nullable().optional(),
    pace_zone_names: z
      .array(z.string().nullable())
      .nullable()
      .optional()
      .catch(null),
    ftp: z.number().nullable().optional(),
    warmup_time: z.number().nullable().optional(),
  })
  .passthrough();

export type IntervalsSportSettings = z.infer<
  typeof IntervalsSportSettingsSchema
>;
const IntervalsSportSettingsListSchema = z.array(IntervalsSportSettingsSchema);

// --- Pace curve schemas ---
// Verified against __fixtures__/intervals/pace-curves.json (2026-09-25) and
// pace-curves-submax.json (2026-10-08), live probes.
const IntervalsPaceModelSchema = z
  .object({
    type: z.string().nullable().optional(),
    criticalSpeed: z.number().nullable().optional(),
    dPrime: z.number().nullable().optional(),
    r2: z.number().nullable().optional(),
    inputPointIndexes: z.array(z.number()).nullable().optional(),
  })
  .passthrough();

/** One named curve (`all`, `1y`, `90d`, or a `r.YYYY-MM-DD.YYYY-MM-DD`
 * custom range) from `GET /athlete/{id}/pace-curves.json`: index-aligned
 * `distance`/`values`/`activity_id` arrays over a fixed distance grid. */
const IntervalsPaceCurveListItemSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable().optional(),
    start_date_local: z.string().nullable().optional(),
    end_date_local: z.string().nullable().optional(),
    days: z.number().nullable().optional(),
    /** Metres, index-aligned with `values` and `activity_id`. */
    distance: z.array(z.number()),
    /** Best time in seconds at the matching `distance` index: elapsed time
     * across the fastest stretch, a stop inside it included (verified
     * 2026-10-08, docs/api-notes.md). */
    values: z.array(z.number().nullable()),
    /** The `i`-prefixed activity id that set the best time at the matching
     * index, or `null` where no activity reaches that distance. */
    activity_id: z.array(z.string().nullable()),
    /** With `subMaxEfforts=N`: N rows, row r the (r+2)th best time (s) at
     * each `distance` index, each from a different activity. A row is
     * truncated, not null-padded, where fewer activities reach the distance
     * (verified 2026-10-08, docs/api-notes.md). */
    submax_values: z
      .array(z.array(z.number().nullable()))
      .nullable()
      .optional(),
    /** The activity ids for `submax_values`, in the same shape. */
    submax_activity_id: z
      .array(z.array(z.string().nullable()))
      .nullable()
      .optional(),
    paceModels: z.array(IntervalsPaceModelSchema).nullable().optional(),
  })
  .passthrough();

/** One entry in `pace-curves.json`'s `activities` map: enough to label a
 * curve point (name, race flag, date) without a second request. */
const IntervalsPaceCurveActivityRefSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    distance: z.number().nullable().optional(),
    moving_time: z.number().nullable().optional(),
    start_date_local: z.string().nullable().optional(),
    race: z.boolean().nullable().optional(),
    training_load: z.number().nullable().optional(),
    icu_weight: z.number().nullable().optional(),
  })
  .passthrough();

/** One named curve (`90d`, `1y`, ...) from `GET /athlete/{id}/hr-curves.json`:
 * index-aligned `secs`/`values`/`activity_id` arrays (verified 2026-10-08). */
const IntervalsHrCurveListItemSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable().optional(),
    start_date_local: z.string().nullable().optional(),
    end_date_local: z.string().nullable().optional(),
    days: z.number().nullable().optional(),
    /** Durations in seconds on intervals.icu's fixed grid, up to the
     * longest activity in the window. */
    secs: z.array(z.number()),
    /** Best average heart rate (bpm) over the matching duration. */
    values: z.array(z.number().nullable()),
    /** The `i`-prefixed activity id that set the matching best. */
    activity_id: z.array(z.string().nullable()),
  })
  .passthrough();

const IntervalsAthleteHrCurvesSchema = z
  .object({
    list: z.array(IntervalsHrCurveListItemSchema),
    // The same map shape as the pace curves (verified 2026-10-08).
    activities: z.record(z.string(), IntervalsPaceCurveActivityRefSchema),
  })
  .passthrough();

export type IntervalsAthleteHrCurves = z.infer<
  typeof IntervalsAthleteHrCurvesSchema
>;

const IntervalsAthletePaceCurvesSchema = z
  .object({
    list: z.array(IntervalsPaceCurveListItemSchema),
    activities: z.record(z.string(), IntervalsPaceCurveActivityRefSchema),
  })
  .passthrough();

export type IntervalsAthletePaceCurves = z.infer<
  typeof IntervalsAthletePaceCurvesSchema
>;

/**
 * An intervals.icu API failure that {@link handleApiError} has already
 * interpreted: the user-facing message, with the HTTP status still attached.
 *
 * Extends {@link HttpError} so the status survives translation, same as the
 * Strava client's `StravaApiError`: a caller degrading on a specific status
 * needs `instanceof`/`.response.status` to still work.
 */
export class IntervalsApiError extends HttpError {
  constructor(message: string, response: HttpErrorResponse) {
    super(message, response);
    this.name = "IntervalsApiError";
  }
}

/**
 * Pulls a human-readable detail out of an error response: a JSON body's
 * `message`, else a one-line summary of the body (an HTML error page becomes
 * its title; see `summarizeErrorBody`), else the status text.
 */
function extractDetail(response: HttpErrorResponse): string {
  const { data, statusText, contentType } = response;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message;
    }
  } catch {
    // data is not JSON; fall through.
  }
  return summarizeErrorBody(data, contentType) || statusText;
}

/**
 * Translates a caught request failure into the shape a caller can rely on.
 *
 * A `RateLimitError` is rethrown intact (unmodified): callers that branch on
 * `instanceof RateLimitError` need the type, and its `detail` already reads as
 * a complete sentence on its own without a context prefix. Every other
 * `HttpError` is wrapped in {@link IntervalsApiError} so the status survives.
 * Anything else (a genuine network/programming fault) is rethrown as-is.
 */
function handleApiError(error: unknown, context: string): never {
  if (error instanceof RateLimitError) {
    throw error;
  }
  if (error instanceof HttpError) {
    const detail = extractDetail(error.response);
    throw new IntervalsApiError(
      `${context}: ${error.response.status} ${detail}`,
      error.response,
    );
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(`An unknown error occurred in ${context}: ${String(error)}`);
}

/**
 * Validates a response body against its schema, or throws a plain `Error`
 * naming the function and the first zod issue path. Deliberately not an
 * {@link IntervalsApiError}: a schema mismatch is not an HTTP failure, and a
 * caller checking `instanceof IntervalsApiError` / `.response.status` must
 * not mistake "the shape changed" for "the request failed".
 */
function parseOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new Error(
      `${context}: invalid intervals.icu response at ${path}: ${
        issue?.message ?? "validation failed"
      }`,
    );
  }
  return result.data;
}

/** Throws before any network call if `apiKey` is empty. */
function requireApiKey(apiKey: string): void {
  if (!apiKey) {
    throw new Error("An intervals.icu API key is required.");
  }
}

/** `Authorization` (Basic) + a descriptive `User-Agent`. Never logged. */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: basicAuthHeader(apiKey),
    "User-Agent": `intervals-mcp/${SERVER_VERSION} (+https://github.com/ljcl/intervals-mcp)`,
  };
}

/** Builds an athlete-scoped path using the configured athlete id. */
function athletePath(suffix: string): string {
  return `/athlete/${getIntervalsAthleteId()}${suffix}`;
}

/** intervals.icu list endpoints paginate by date, not by page; cap a single
 * request's window so a multi-month scan doesn't send one unbounded query. */
const MAX_WINDOW_DAYS = 31;

export interface DateRange {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  oldest: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  newest: string;
}

/**
 * Splits `[oldest, newest]` into consecutive inclusive windows of at most
 * {@link MAX_WINDOW_DAYS} calendar days each. A range that already fits in
 * one window comes back as a single-element array. Built entirely on
 * `addDays` (`utils/localDate.ts`) rather than its own date parse/format, so
 * the UTC-midnight day math has one implementation shared with every other
 * date-window tool.
 */
export function splitDateRangeIntoWindows(
  oldest: string,
  newest: string,
): DateRange[] {
  const windows: DateRange[] = [];
  let windowStart = oldest;
  while (windowStart <= newest) {
    const windowEnd = addDays(windowStart, MAX_WINDOW_DAYS - 1);
    const cappedEnd = windowEnd > newest ? newest : windowEnd;
    windows.push({ oldest: windowStart, newest: cappedEnd });
    windowStart = addDays(cappedEnd, 1);
  }
  return windows;
}

/**
 * Lists activities across `range`, splitting anything longer than 31 days
 * into consecutive 31-day windows fetched sequentially (never in parallel,
 * so the shared client's request spacing and any future rate-limit backoff
 * apply per request as intended). Results are concatenated, de-duplicated by
 * `id`, and sorted by `start_date_local` descending.
 *
 * A multi-window scan reports progress once per window. A 515-day run-only
 * lookback is 17 requests in a row, and without a message between them a
 * streamed call showed nothing for that long (#51).
 */
export async function listActivities(
  apiKey: string,
  range: DateRange,
  progress: ReportProgress = NO_PROGRESS,
): Promise<IntervalsActivity[]> {
  requireApiKey(apiKey);
  const windows = splitDateRangeIntoWindows(range.oldest, range.newest);
  const collected: IntervalsActivity[] = [];

  for (const [index, window] of windows.entries()) {
    if (windows.length > 1) {
      progress(
        `Listing activities ${window.oldest} to ${window.newest} (window ${index + 1} of ${windows.length})…`,
      );
    }
    const context = `listActivities for ${window.oldest} to ${window.newest}`;
    let data: unknown;
    try {
      const response = await intervalsApi.get<unknown>(
        athletePath("/activities"),
        {
          headers: authHeaders(apiKey),
          params: { oldest: window.oldest, newest: window.newest },
        },
      );
      data = response.data;
    } catch (error) {
      handleApiError(error, context);
    }
    collected.push(
      ...parseOrThrow(IntervalsActivitiesResponseSchema, data, context),
    );
  }

  const byId = new Map<string, IntervalsActivity>();
  for (const activity of collected) byId.set(activity.id, activity);
  return Array.from(byId.values()).sort((a, b) =>
    a.start_date_local < b.start_date_local
      ? 1
      : a.start_date_local > b.start_date_local
        ? -1
        : 0,
  );
}

/**
 * Searches every activity in the athlete's history by name, or by exact tag
 * when `query` starts with `#`, via `GET /athlete/{id}/activities/search-full`
 * (full Activity rows, case-insensitive name match, not bounded by date;
 * verified 2026-10-05, docs/api-notes.md). Sorted newest first.
 */
export async function searchActivities(
  apiKey: string,
  query: string,
  limit: number,
): Promise<IntervalsActivity[]> {
  requireApiKey(apiKey);
  const context = `searchActivities for "${query}"`;
  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      athletePath("/activities/search-full"),
      { headers: authHeaders(apiKey), params: { q: query, limit } },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsActivitiesResponseSchema, data, context).sort(
    (a, b) =>
      a.start_date_local < b.start_date_local
        ? 1
        : a.start_date_local > b.start_date_local
          ? -1
          : 0,
  );
}

/**
 * Fetches a single activity. `options.intervals: true` adds
 * `?intervals=true`, which populates the activity's `icu_intervals` field
 * (empty otherwise; see docs/api-notes.md). `options.skipCache: true` bypasses
 * the response cache entirely (neither reads nor stores), for a caller that
 * needs a guaranteed-fresh read, e.g. immediately after `updateActivity`.
 */
export async function getActivity(
  apiKey: string,
  id: string,
  options: { intervals?: boolean; skipCache?: boolean } = {},
): Promise<IntervalsActivity> {
  requireApiKey(apiKey);
  const context = `getActivity for ID ${id}`;
  const params: Record<string, string | number | boolean> = {};
  if (options.intervals) params.intervals = true;

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(`/activity/${id}`, {
      headers: authHeaders(apiKey),
      params,
      skipCache: options.skipCache,
    });
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsActivitySchema, data, context);
}

/** Writable activity fields for {@link updateActivity}; only the keys the
 * caller supplies are sent (unset keys are `undefined`, dropped by
 * `JSON.stringify`), so a partial patch never overwrites an untouched field. */
export interface IntervalsActivityUpdate {
  name?: string;
  description?: string;
  gear?: { id: string };
  icu_rpe?: number;
  feel?: number;
}

/**
 * Updates an activity via `PUT /activity/{id}`, sending only the keys in
 * `patch`. Like every write in this client, it goes through `intervalsApi`
 * unretried (fetchClient.ts only retries GET/HEAD; a PUT that fails mid-flight
 * may already have mutated state, so it surfaces the error instead of
 * silently repeating it): a `RateLimitError` is rethrown intact, anything else
 * wrapped in {@link IntervalsApiError}.
 *
 * Invalidates the activity's own cached reads, the athlete's activities
 * list, the gear list, and the athlete pace curves (their `activities` map
 * carries each ranked run's name, which `get-best-efforts` reports) in a
 * `finally`, whatever the outcome: a failed PUT (a 5xx, a network fault, a
 * timeout) may still have mutated state server-side, and `fetchClient.ts`'s automatic write invalidation only
 * fires on a successful response, so without this a caller reading right
 * after a failed write could keep being served the pre-write cache entry.
 */
export async function updateActivity(
  apiKey: string,
  id: string,
  patch: IntervalsActivityUpdate,
): Promise<IntervalsActivity> {
  requireApiKey(apiKey);
  const context = `updateActivity for ID ${id}`;

  let data: unknown;
  try {
    const response = await intervalsApi.put<unknown>(`/activity/${id}`, patch, {
      headers: authHeaders(apiKey),
    });
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  } finally {
    intervalsApi.invalidatePath(`/activity/${id}`);
    intervalsApi.invalidatePath(athletePath("/activities"));
    intervalsApi.invalidatePath(athletePath("/gear"));
    intervalsApi.invalidatePath(athletePath("/pace-curves.json"));
  }
  return parseOrThrow(IntervalsActivitySchema, data, context);
}

/** Fetches an activity's interval (WORK/RECOVERY) breakdown. */
export async function getActivityIntervals(
  apiKey: string,
  id: string,
): Promise<IntervalsIntervals> {
  requireApiKey(apiKey);
  const context = `getActivityIntervals for ID ${id}`;

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      `/activity/${id}/intervals`,
      { headers: authHeaders(apiKey) },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsIntervalsSchema, data, context);
}

/** Fetches the requested data streams for an activity. */
export async function getActivityStreams(
  apiKey: string,
  id: string,
  types: string[],
): Promise<IntervalsStream[]> {
  requireApiKey(apiKey);
  const context = `getActivityStreams for ID ${id}`;

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      `/activity/${id}/streams.json?types=${types.join(",")}`,
      { headers: authHeaders(apiKey) },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsStreamsResponseSchema, data, context);
}

/**
 * Lists the authenticated athlete's gear (shoes/bikes). `options.skipCache:
 * true` bypasses the response cache entirely, for a caller that needs a
 * guaranteed-fresh list, e.g. `update-activity` validating a `gearId`
 * against gear that may have just been added.
 */
export async function listGear(
  apiKey: string,
  options: { skipCache?: boolean } = {},
): Promise<IntervalsGear[]> {
  requireApiKey(apiKey);
  const context = "listGear";

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(athletePath("/gear"), {
      headers: authHeaders(apiKey),
      skipCache: options.skipCache,
    });
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsGearResponseSchema, data, context);
}

/**
 * Fetches daily wellness records across `range`. `options.fields` sends
 * `fields=` (comma-joined) so the response carries only the requested keys
 * (verified 2026-09-25, docs/api-notes.md), useful for a caller that only
 * needs `ctl`/`atl`/`ctlLoad`/`atlLoad` from a long window.
 */
export async function getWellness(
  apiKey: string,
  range: DateRange,
  options: { fields?: string[] } = {},
): Promise<IntervalsWellness[]> {
  requireApiKey(apiKey);
  const context = `getWellness for ${range.oldest} to ${range.newest}`;
  const params: Record<string, string> = {
    oldest: range.oldest,
    newest: range.newest,
  };
  if (options.fields && options.fields.length > 0) {
    params.fields = options.fields.join(",");
  }

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(athletePath("/wellness"), {
      headers: authHeaders(apiKey),
      params,
    });
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsWellnessResponseSchema, data, context);
}

/** Fetches per-sport zone/threshold settings (e.g. `type: "Run"`). */
export async function getSportSettings(
  apiKey: string,
  type: string,
): Promise<IntervalsSportSettings> {
  requireApiKey(apiKey);
  const context = `getSportSettings for ${type}`;

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      athletePath(`/sport-settings/${type}`),
      { headers: authHeaders(apiKey) },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsSportSettingsSchema, data, context);
}

/**
 * Fetches every sport settings group in one request (verified 2026-10-08:
 * one entry per group, each the same shape as `/sport-settings/{type}`).
 * `get-athlete-zones` matches its `sport` against each group's `types`.
 */
export async function listSportSettings(
  apiKey: string,
): Promise<IntervalsSportSettings[]> {
  requireApiKey(apiKey);
  const context = "listSportSettings";

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      athletePath("/sport-settings"),
      { headers: authHeaders(apiKey) },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsSportSettingsListSchema, data, context);
}

/**
 * Fetches the athlete's best heart rate curves for one sport settings
 * group: `type` picks the group, not one activity type. Works with athlete
 * id `0`, and `f1`/`f2`/`f3` are not needed, although the spec marks them
 * as required (verified 2026-10-08). A window with no activities is left
 * out of `list`.
 */
export async function getAthleteHrCurves(
  apiKey: string,
  options: { type: string; curves: string[] },
): Promise<IntervalsAthleteHrCurves> {
  requireApiKey(apiKey);
  const context = `getAthleteHrCurves for ${options.curves.join(",")}`;

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      athletePath("/hr-curves.json"),
      {
        headers: authHeaders(apiKey),
        params: { type: options.type, curves: options.curves.join(",") },
      },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsAthleteHrCurvesSchema, data, context);
}

/**
 * Fetches the athlete's own pace curves (best time per distance, across one
 * or more named windows in one request). Works with athlete id `0` (verified
 * 2026-09-25). `subMaxEfforts` above 0 adds that many ranks below the best,
 * each from another activity, in the same response (`submax_values`,
 * verified 2026-10-08); 0 or absent sends no parameter, so the URL and its
 * cache key stay the plain read.
 */
export async function getAthletePaceCurves(
  apiKey: string,
  options: { type: string; curves: string[]; subMaxEfforts?: number },
): Promise<IntervalsAthletePaceCurves> {
  requireApiKey(apiKey);
  const context = `getAthletePaceCurves for ${options.curves.join(",")}`;
  const params: Record<string, string | number> = {
    type: options.type,
    curves: options.curves.join(","),
  };
  if (options.subMaxEfforts && options.subMaxEfforts > 0) {
    params.subMaxEfforts = options.subMaxEfforts;
  }

  let data: unknown;
  try {
    const response = await intervalsApi.get<unknown>(
      athletePath("/pace-curves.json"),
      { headers: authHeaders(apiKey), params },
    );
    data = response.data;
  } catch (error) {
    handleApiError(error, context);
  }
  return parseOrThrow(IntervalsAthletePaceCurvesSchema, data, context);
}
