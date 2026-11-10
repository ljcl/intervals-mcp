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

/** Pelias layers precise enough to route through; a via matched only coarser (neighbourhood, locality, ...) is refused (`coarseVia`, routeSuggestions.ts). */
export const PRECISE_LAYERS = new Set(["venue", "address", "street"]);
// Not the same set as routeBuilder's PRECISE_MATCHES, which only warns (street stays routable here); thresholds differ on purpose.
/** The layered lookup stays this close to the focus: focus only biases, and a same-named street can sit anywhere. */
export const GEOCODE_CIRCLE_KM = 50;
/** Hits read per lookup: Pelias can rank a road above the park named for it (Pirrama Road over Pirrama Park). */
export const GEOCODE_HITS = 10;
/** Where a hit's words are looked for: its name, label and the places it sits in (a "Sydney" in the text is the county, not in the label). */
const PLACE_WORD_FIELDS = [
  "name",
  "label",
  "street",
  "neighbourhood",
  "borough",
  "locality",
  "localadmin",
  "county",
  "macrocounty",
  "region",
  "region_a",
  "macroregion",
  "country",
  "country_a",
] as const;
/** Street words written one way, so "Pirrama Rd" finds Pirrama Road; "st" is street and saint. */
const WORD_FORMS: Record<string, string> = {
  street: "st",
  saint: "st",
  road: "rd",
  avenue: "ave",
  av: "ave",
  parade: "pde",
  highway: "hwy",
  drive: "dr",
  lane: "ln",
  place: "pl",
  crescent: "cres",
  terrace: "tce",
  boulevard: "blvd",
  boulevarde: "blvd",
  bvd: "blvd",
  square: "sq",
  mount: "mt",
  point: "pt",
};
/** Joining words a label may leave out ("the Anzac Bridge"). */
const FILLER_WORDS = new Set(["the", "and", "of"]);

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

/** What a place lookup matched: the text asked, the match's name and its Pelias layer. */
export interface PlaceMatch {
  query: string;
  name: string;
  /** venue, address, street, neighbourhood, locality, ... */
  type: string;
  /** Words of the query the match has nowhere in its name or places (Pelias rates a wrong fuzzy match exact); absent or empty when it has them all. */
  missing?: string[];
}

export interface Place {
  label: string;
  point: LatLng;
  /** Absent for a lat,lng, which needs no lookup. */
  match?: PlaceMatch;
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
  /** Named steps as [first, last] track indexes and the way's name. */
  named_spans: Array<[number, number, string]>;
  /** ORS waytype as [first, last] track indexes and the waytype. */
  waytype_spans: Array<[number, number, number]>;
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
          properties: z
            .object({
              label: z.string(),
              name: z.string().optional(),
              layer: z.string().optional(),
            })
            .passthrough(),
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
                                way_points: z
                                  .tuple([z.number(), z.number()])
                                  .optional(),
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
                        values: z
                          .array(z.tuple([z.number(), z.number(), z.number()]))
                          .optional(),
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

/** The words of a place text, lowercased, accents, apostrophes and joining words dropped, street words in one form. */
export function placeWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .map((w) => WORD_FORMS[w] ?? w);
}

/**
 * The best place for `text`, biased toward `focus`, or null when none
 * matched: the first hit with every word of the text, else the first hit
 * (its `match.missing` names the words it lacks). Pelias ranks a suburb above
 * a named bridge or park, so with a focus point the precise layers are asked
 * first and any layer only when they have nothing. Without a focus the
 * filter can pick a far-away place, so there is one unfiltered lookup
 * (docs/api-notes.md).
 */
export async function geocode(
  key: string,
  text: string,
  focus: LatLng | null,
): Promise<Place | null> {
  if (!focus) return geocodeOnce(key, text, null, null);
  return (
    (await geocodeOnce(key, text, focus, [...PRECISE_LAYERS].join(","))) ??
    (await geocodeOnce(key, text, focus, null))
  );
}

async function geocodeOnce(
  key: string,
  text: string,
  focus: LatLng | null,
  layers: string | null,
): Promise<Place | null> {
  const context = "look up a place";
  const params: Record<string, string | number> = { text, size: GEOCODE_HITS };
  if (layers) params.layers = layers;
  if (focus) {
    params["focus.point.lat"] = focus[0];
    params["focus.point.lon"] = focus[1];
    if (layers) {
      params["boundary.circle.lat"] = focus[0];
      params["boundary.circle.lon"] = focus[1];
      params["boundary.circle.radius"] = GEOCODE_CIRCLE_KM;
    }
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
  const hits = parseOrThrow(GeocodeSchema, data, context).features;
  if (hits.length === 0) return null;
  const asked = [...new Set(placeWords(text))];
  const scored = hits.map((hit) => {
    const props = hit.properties as Record<string, unknown>;
    const has = new Set(
      PLACE_WORD_FIELDS.flatMap((field) =>
        typeof props[field] === "string" ? placeWords(props[field]) : [],
      ),
    );
    return { hit, missing: asked.filter((w) => !has.has(w)) };
  });
  const { hit, missing } =
    scored.find((s) => s.missing.length === 0) ?? scored[0]!;
  const [lng, lat] = hit.geometry.coordinates;
  const { label, name, layer } = hit.properties;
  return {
    label,
    point: [lat, lng],
    match: {
      query: text,
      name: name ?? label,
      type: layer ?? "unknown",
      missing,
    },
  };
}

/** Parses a foot route (exported for tests and the spike fixtures). */
export function parseOrsRoute(data: unknown): OrsRoute {
  const feature = parseOrThrow(RouteSchema, data, "read a route").features[0]!;
  const coordinates: LatLng[] = feature.geometry.coordinates.map(
    ([lng, lat]) => [lat!, lng!],
  );
  const altitude = feature.geometry.coordinates.map((c) => c[2] ?? null);
  const props = feature.properties;

  const named_spans: Array<[number, number, string]> = [];
  for (const segment of props.segments ?? []) {
    for (const step of segment.steps ?? []) {
      const name = step.name?.trim();
      if (!name || name === "-" || !step.way_points) continue;
      named_spans.push([...step.way_points, name]);
    }
  }
  const waytype_spans = props.extras?.waytype?.values ?? [];
  const ferry_m = (props.extras?.waytype?.summary ?? [])
    .filter((w) => w.value === FERRY_WAYTYPE)
    .reduce((sum, w) => sum + w.distance, 0);
  const track = {
    coordinates,
    distance: cumulativeDistances(coordinates),
    altitude,
  };
  const leg = orsLegSummary(
    { track, named_spans, waytype_spans },
    coordinates.length - 1,
  );

  return {
    track,
    distance_m: props.summary.distance,
    ascent_m: props.ascent ?? 0,
    path_share: leg.path_share,
    ferry_m,
    way_names: leg.way_names,
    named_spans,
    waytype_spans,
  };
}

/**
 * Path share and the longest named ways of a route up to track index `end`:
 * an out-and-back runs only the leg to its turn, so the rest of the loop
 * must not name its streets.
 */
export function orsLegSummary(
  route: Pick<OrsRoute, "track" | "named_spans" | "waytype_spans">,
  end: number,
): { path_share: number; way_names: string[] } {
  const d = route.track.distance;
  const metres = (from: number, to: number) =>
    from >= end ? 0 : (d[Math.min(to, end)] ?? 0) - (d[from] ?? 0);
  const byName = new Map<string, number>();
  for (const [from, to, name] of route.named_spans)
    byName.set(name, (byName.get(name) ?? 0) + metres(from, to));
  const way_names = [...byName.entries()]
    .filter(([, m]) => m > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, WAY_NAME_COUNT)
    .map(([name]) => name);
  let total = 0;
  let onPaths = 0;
  for (const [from, to, value] of route.waytype_spans) {
    const m = metres(from, to);
    total += m;
    if (PATH_WAYTYPES.has(value)) onPaths += m;
  }
  return { path_share: total > 0 ? onPaths / total : 0, way_names };
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
