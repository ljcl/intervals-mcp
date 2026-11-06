import { z } from "zod";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  MAX_STITCH_SEGMENTS,
  type SegmentInput,
  stitchRoute,
  summarizeRoute,
} from "../routeBuilder";
import { WRITE_IDEMPOTENT } from "./_annotations";
import { intervalsActivityIdInput } from "./_ids";
import {
  kmInput,
  placeText,
  routeBuildEnv,
  routeErrorResult,
  routeIdInput,
  storedRouteLines,
  storedRouteStructured,
} from "./_storedRoutes";
import { StoredRouteOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "stitch-route";

const description = `
Joins parts of past runs, stored routes and new routed sections into one
stored route, for "run my Sunday route but add an out-and-back to Iron
Cove at the halfway point" or "start with the first 5 km of last week's
long run, then head home". Returns a route_id and version 1, with the
distance, climb, share on paths and the km range of each section; never
the geometry. Then: view-route-map with route_id to see it, amend-route to
change one part, export-route for a GPX file. For where to run a planned
run, use suggest-run-route first; its generated routes have a route_id.

Segments, in running order:
- activity: a past run's km range (from_km above to_km runs it backwards).
- route: a stored route's km range.
- generated: routed by OpenRouteService through via points. Start defaults
  to where the section before ends, end to where the next starts (the last
  one goes back to the route's start).
- out_and_back: there and back toward a place or a compass direction.

Notes:
- Ends within 30 m are joined directly; a wider gap is routed, and a gap
  that cannot be routed is an error that says where it is.
- Each section keeps its source and its climb. A routed section's climb is
  OpenRouteService's elevation model; a past run's is its own altitude.
- One call makes at most 12 routing calls; a stitch needing more stores
  nothing. Places and points are sent to OpenRouteService.
- The same request returns the same route_id and stores nothing new.
- Mark a generated section or out-and-back flexible so amend-route's
  fit_distance can change its length.
`;

const segment = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("activity"),
    id: intervalsActivityIdInput("The past run to take a part of.", {
      allowLatest: false,
    }),
    from_km: kmInput("Its own km to start at; default 0").optional(),
    to_km: kmInput("Its own km to end at; default its end").optional(),
  }),
  z.object({
    type: z.literal("route"),
    route_id: routeIdInput("A stored route to take a part of"),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Its version; default the latest"),
    from_km: kmInput("Its km to start at; default 0").optional(),
    to_km: kmInput("Its km to end at; default its end").optional(),
  }),
  z.object({
    type: z.literal("generated"),
    start: placeText
      .optional()
      .describe(
        "A place with its city, or lat,lng; default where the section before ends",
      ),
    end: placeText
      .optional()
      .describe(
        "A place with its city, or lat,lng; default where the next section starts",
      ),
    via: z
      .array(placeText)
      .max(5)
      .optional()
      .describe("Places to pass in order"),
    flexible: z
      .boolean()
      .optional()
      .describe("amend-route's fit_distance may change this section"),
  }),
  z.object({
    type: z.literal("out_and_back"),
    at: placeText
      .optional()
      .describe("Where it turns off; default where the section before ends"),
    toward: placeText.describe(
      'A place with its city, lat,lng, or a direction ("west", "NE", "270")',
    ),
    distance_km: z
      .number()
      .positive()
      .max(50)
      .describe("Out and back together, km"),
    flexible: z
      .boolean()
      .optional()
      .describe("amend-route's fit_distance may change its length"),
  }),
]);

const inputSchema = z.object({
  segments: z
    .array(segment)
    .min(1)
    .max(MAX_STITCH_SEGMENTS)
    .describe("The sections in running order"),
  name: z.string().trim().min(1).max(80).optional().describe("A name for it"),
});

type StitchRouteInput = z.infer<typeof inputSchema>;

export const stitchRouteTool = {
  name,
  title: "Stitch a route",
  description,
  inputSchema,
  annotations: WRITE_IDEMPOTENT,
  outputSchema: StoredRouteOutputSchema,
  execute: async (
    args: StitchRouteInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      const built = await stitchRoute(
        apiKey,
        { name: args.name, segments: args.segments as SegmentInput[] },
        routeBuildEnv(),
        progress,
      );
      const structured = storedRouteStructured(
        summarizeRoute(built.route, built.version),
        {
          applied: true,
          created: built.created,
          change: null,
          ors_calls: built.ors_calls,
          warnings: built.created
            ? []
            : [
                `This request was already stitched as route ${built.route.route_id}; its version ${built.version.version} is returned and nothing was routed again.`,
              ],
        },
      );
      warnOnSchemaDrift(name, StoredRouteOutputSchema, structured);
      return {
        content: [
          {
            type: "text" as const,
            text: storedRouteLines(structured).join("\n"),
          },
        ],
        structuredContent: structured,
      };
    } catch (error) {
      return routeErrorResult(error, "stitch a route");
    }
  },
};
