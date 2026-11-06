import { z } from "zod";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  type AmendOperation,
  amendRoute,
  compareVersions,
  loadRouteVersion,
  MAX_AMEND_OPERATIONS,
  RouteBuildError,
  summarizeRoute,
} from "../routeBuilder";
import { latestVersion, SUGGESTION_RETENTION_DAYS } from "../routeStore";
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

const name = "amend-route";

const description = `
Changes one part of a stored route and stores the result as a new
version, for "move the turnaround 200 m west", "go through the park
instead", "cut out km 3 to 4" or "make it 15 km". Only the changed part is
routed again; the rest keeps its sections. Every earlier version is kept:
undo or restore makes the old track the newest version. Returns the new
version, the distance change and the km range that changed, never the
geometry; view-route-map with compare_to_version shows the change.

Pass base_version, the version the change is made from: the call is
refused unless it is still the latest, so a change made from an old
version never drops a newer one. Via ids (v3) and section km come from
stitch-route's or an earlier amend-route's result.

Operations run in order on one new version:
- insert_via: route through a place, near a km (within 1 km either side).
- remove_via / move_via: a via point or an out-and-back's turnaround.
- replace_section: route km from-to again, directly, through a place, or
  along part of a past run.
- add_out_and_back: at a km, toward a place or a direction.
- trim: remove km from-to and reconnect the ends.
- fit_distance: change the flexible section (or km from-to) so the whole
  route is target_km.
- reverse; undo; restore (undo and restore go alone).

Notes:
- One call makes at most 12 routing calls. A change needing more stores
  nothing and returns a warning; the latest version stays as it was.
- Places and points are sent to OpenRouteService.
`;

const shift = z
  .object({
    direction: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .describe('A compass direction ("west", "NE") or degrees'),
    distance_m: z.number().positive().max(5000),
  })
  .describe("Move the point this far, instead of to a place");

const operation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("insert_via"),
    km: kmInput("Route km the new point is nearest"),
    place: placeText.describe("A place with its city, or lat,lng"),
    label: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({
    op: z.literal("remove_via"),
    via_id: z.string().trim().min(2).max(12).describe("e.g. v3"),
  }),
  z.object({
    op: z.literal("move_via"),
    via_id: z.string().trim().min(2).max(12).describe("e.g. v3"),
    to: placeText.optional().describe("A place with its city, or lat,lng"),
    shift: shift.optional(),
  }),
  z.object({
    op: z.literal("replace_section"),
    from_km: kmInput("Route km the section starts at"),
    to_km: kmInput("Route km the section ends at"),
    through: placeText
      .optional()
      .describe("Route through this place instead of directly"),
    activity: z
      .object({
        id: intervalsActivityIdInput("A past run to use instead.", {
          allowLatest: false,
        }),
        from_km: kmInput("Its own km to start at").optional(),
        to_km: kmInput("Its own km to end at").optional(),
      })
      .optional()
      .describe("Use part of a past run instead; its ends are routed to"),
  }),
  z.object({
    op: z.literal("add_out_and_back"),
    km: kmInput("Route km it turns off at"),
    toward: placeText.describe(
      'A place with its city, lat,lng, or a direction ("west", "NE")',
    ),
    distance_km: z
      .number()
      .positive()
      .max(50)
      .describe("Out and back together"),
  }),
  z.object({
    op: z.literal("trim"),
    from_km: kmInput("Route km to cut from"),
    to_km: kmInput("Route km to cut to"),
  }),
  z.object({
    op: z.literal("fit_distance"),
    target_km: z.number().positive().max(200).describe("Whole route, km"),
    from_km: kmInput("Section to change; default the flexible one").optional(),
    to_km: kmInput("Section to change").optional(),
  }),
  z.object({ op: z.literal("reverse") }),
  z.object({ op: z.literal("undo") }),
  z.object({
    op: z.literal("restore"),
    version: z.number().int().positive(),
  }),
]);

const inputSchema = z.object({
  route_id: routeIdInput("The stored route to change"),
  base_version: z
    .number()
    .int()
    .positive()
    .describe("The version the change is made from; must be the latest"),
  operations: z
    .array(operation)
    .min(1)
    .max(MAX_AMEND_OPERATIONS)
    .describe("Changes, applied in order into one new version"),
});

type AmendRouteInput = z.infer<typeof inputSchema>;

export const amendRouteTool = {
  name,
  title: "Change a route",
  description,
  inputSchema,
  annotations: WRITE_IDEMPOTENT,
  outputSchema: StoredRouteOutputSchema,
  execute: async (
    args: AmendRouteInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      let structured: ReturnType<typeof storedRouteStructured>;
      try {
        const done = await amendRoute(
          apiKey,
          {
            route_id: args.route_id,
            base_version: args.base_version,
            operations: args.operations as AmendOperation[],
          },
          routeBuildEnv(),
          progress,
        );
        structured = storedRouteStructured(
          summarizeRoute(done.route, done.version),
          {
            applied: true,
            created: true,
            change: compareVersions(done.route, done.base, done.version),
            ors_calls: done.ors_calls,
            warnings:
              done.route.kind === "suggestion"
                ? [
                    `Route ${done.route.route_id} is a suggested route, kept ${SUGGESTION_RETENTION_DAYS} days after its last use. To keep it longer, stitch it into a route of your own (stitch-route with one "route" segment).`,
                  ]
                : [],
          },
        );
      } catch (error) {
        // Out of budget: nothing was stored, and the latest version stands.
        if (!(error instanceof RouteBuildError && error.kind === "budget"))
          throw error;
        const { route } = await loadRouteVersion(args.route_id);
        const latest = latestVersion(route);
        structured = storedRouteStructured(summarizeRoute(route, latest), {
          applied: false,
          created: false,
          change: null,
          ors_calls: 0,
          warnings: [
            `No change was made: ${error.message} Version ${latest.version} is still the latest; make the change in smaller steps.`,
          ],
        });
      }
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
      return routeErrorResult(error, "change a route");
    }
  },
};
