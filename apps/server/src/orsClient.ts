/**
 * OpenRouteService: geocoding and foot routing for route suggestions, the
 * only module that calls it (intervals.icu data stays in intervalsClient.ts;
 * docs/architecture.md). Coordinates sent here leave the server
 * (docs/operations.md), so they never appear in a log line or message.
 * ORS takes and returns [lng, lat]; everything this module returns is
 * [lat, lng].
 */
import { z } from "zod";
import { CallCancelledError } from "./callScope";
import {
  HttpError,
  type HttpErrorResponse,
  orsApi,
  RateLimitError,
  summarizeErrorBody,
} from "./fetchClient";
import {
  cumulativeDistances,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { SERVER_VERSION } from "./version";

/** Waypoints ORS spreads around a round trip; more gives a rounder loop. */
export const ROUND_TRIP_POINTS = 4;

/** ORS waytype values that keep a runner off roads: Path, Track, Cycleway, Footway (docs/api-notes.md). */
export const PATH_WAYTYPES = new Set([4, 5, 6, 7]);
/** ORS waytype Ferry: a route on one is not a run. */
const FERRY_WAYTYPE = 9;

/** How many named ways a route summary lists, longest first. */
const WAY_NAME_COUNT = 4;

export class OrsApiError extends HttpError {
  constructor(message: string, response: HttpErrorResponse) {
    super(message, response);
    this.name = "OrsApiError";
  }
}

export interface Place {
  label: string;
  point: LatLng;
}

export interface OrsRoute {
  track: RouteTrack;
  /** ORS's own route length, m. */
  distance_m: number;
  ascent_m: number;
  /** Share (0-1) of the route on {@link PATH_WAYTYPES}. */
  path_share: number;
  /** Metres on a ferry ({@link FERRY_WAYTYPE}); the engine drops a route with any. */
  ferry_m: number;
  /** The longest named ways, longest first. */
  way_names: string[];
}

export interface OrsRouteRequest {
  /** Start, any via points, end. One point with `roundTrip` makes a loop. */
  waypoints: LatLng[];
  roundTrip?: { length_m: number; seed: number };
}

const GeocodeSchema = z
  .object({
    features: z.array(
      z
        .object({
          geometry: z.object({
            coordinates: z.tuple([z.number(), z.number()]),
          }),
          properties: z.object({ label: z.string() }).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const RouteSchema = z
  .object({
    features: z
      .array(
        z
          .object({
            geometry: z.object({
              coordinates: z.array(z.array(z.number()).min(2)),
            }),
            properties: z
              .object({
                summary: z.object({ distance: z.number() }).passthrough(),
                ascent: z.number().optional(),
                segments: z
                  .array(
                    z
                      .object({
                        steps: z
                          .array(
                            z
                              .object({
                                distance: z.number(),
                                name: z.string().optional(),
                              })
                              .passthrough(),
                          )
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
                extras: z
                  .object({
                    waytype: z
                      .object({
                        summary: z.array(
                          z
                            .object({ value: z.number(), distance: z.number() })
                            .passthrough(),
                        ),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

function headers(key: string): Record<string, string> {
  return {
    Authorization: key,
    "User-Agent": `intervals-mcp/${SERVER_VERSION} (+https://github.com/ljcl/intervals-mcp)`,
  };
}

function orsDetail(response: HttpErrorResponse): string {
  try {
    const { error } = JSON.parse(response.data) as { error?: unknown };
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON; fall through.
  }
  return (
    summarizeErrorBody(response.data, response.contentType) ||
    response.statusText
  );
}

/**
 * Same contract as intervalsClient's handleApiError: rate limits intact, HTTP
 * failures typed. A cancellation is rethrown as `what` stopping, since its
 * message is the request URL, which carries coordinates.
 */
function handleOrsError(error: unknown, context: string, what: string): never {
  if (error instanceof CallCancelledError)
    throw new CallCancelledError(what, { cause: error.cause });
  if (error instanceof RateLimitError) throw error;
  if (error instanceof HttpError) {
    throw new OrsApiError(
      `${context}: ${error.response.status} ${orsDetail(error.response)}`,
      error.response,
    );
  }
  throw error;
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string,
): T {
  // ORS answers `application/geo+json`, which FetchClient leaves as text.
  let json: unknown = data;
  try {
    if (typeof data === "string") json = JSON.parse(data);
  } catch {
    json = undefined;
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(`${context}: invalid OpenRouteService response`);
  }
  return result.data;
}

/** The top place for `text`, biased toward `focus`, or null when none matched. */
export async function geocode(
  key: string,
  text: string,
  focus: LatLng | null,
): Promise<Place | null> {
  const context = "look up a place";
  const params: Record<string, string | number> = { text, size: 1 };
  if (focus) {
    params["focus.point.lat"] = focus[0];
    params["focus.point.lon"] = focus[1];
  }
  let data: unknown;
  try {
    data = (
      await orsApi.get<unknown>("/geocode/search", {
        headers: headers(key),
        params,
        responseType: "text",
      })
    ).data;
  } catch (error) {
    handleOrsError(error, context, "Looking up a place");
  }
  const hit = parseOrThrow(GeocodeSchema, data, context).features[0];
  if (!hit) return null;
  const [lng, lat] = hit.geometry.coordinates;
  return { label: hit.properties.label, point: [lat, lng] };
}

/** Parses a foot route (exported for tests and the spike fixtures). */
export function parseOrsRoute(data: unknown): OrsRoute {
  const feature = parseOrThrow(RouteSchema, data, "read a route").features[0]!;
  const coordinates: LatLng[] = feature.geometry.coordinates.map(
    ([lng, lat]) => [lat!, lng!],
  );
  const altitude = feature.geometry.coordinates.map((c) => c[2] ?? null);
  const props = feature.properties;

  const byName = new Map<string, number>();
  for (const segment of props.segments ?? []) {
    for (const step of segment.steps ?? []) {
      const name = step.name?.trim();
      if (!name || name === "-") continue;
      byName.set(name, (byName.get(name) ?? 0) + step.distance);
    }
  }
  const way_names = [...byName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, WAY_NAME_COUNT)
    .map(([name]) => name);

  const waytypes = props.extras?.waytype?.summary ?? [];
  const total = waytypes.reduce((sum, w) => sum + w.distance, 0);
  const onPaths = waytypes
    .filter((w) => PATH_WAYTYPES.has(w.value))
    .reduce((sum, w) => sum + w.distance, 0);
  const ferry_m = waytypes
    .filter((w) => w.value === FERRY_WAYTYPE)
    .reduce((sum, w) => sum + w.distance, 0);

  return {
    track: {
      coordinates,
      distance: cumulativeDistances(coordinates),
      altitude,
    },
    distance_m: props.summary.distance,
    ascent_m: props.ascent ?? 0,
    path_share: total > 0 ? onPaths / total : 0,
    ferry_m,
    way_names,
  };
}

/** A foot route through `waypoints`, or a loop from one point with `roundTrip`. */
export async function orsRoute(
  key: string,
  request: OrsRouteRequest,
): Promise<OrsRoute> {
  const context = request.roundTrip
    ? "generate a loop"
    : "route between places";
  // Ferries on every request: ORS routed 24 km of a 6 km loop by ferry (docs/api-notes.md).
  const options: Record<string, unknown> = { avoid_features: ["ferries"] };
  if (request.roundTrip) {
    options.round_trip = {
      length: Math.round(request.roundTrip.length_m),
      points: ROUND_TRIP_POINTS,
      seed: request.roundTrip.seed,
    };
  }
  const body = {
    coordinates: request.waypoints.map(([lat, lng]) => [lng, lat]),
    elevation: true,
    instructions: true,
    extra_info: ["waytype"],
    options,
  };
  let data: unknown;
  try {
    data = (
      await orsApi.post<unknown>("/v2/directions/foot-walking/geojson", body, {
        headers: headers(key),
        readOnly: true,
        responseType: "text",
      })
    ).data;
  } catch (error) {
    handleOrsError(error, context, "Routing");
  }
  return parseOrsRoute(data);
}
