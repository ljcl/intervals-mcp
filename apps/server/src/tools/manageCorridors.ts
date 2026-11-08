import { z } from "zod";
import { corridorKey } from "../corridors";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { addCorridor, type CorridorSource } from "../routeBuilder";
import {
  CorridorNotFoundError,
  deleteCorridor,
  isRouteId,
  listCorridors,
  updateCorridor,
} from "../routeStore";
import { WRITE_DESTRUCTIVE } from "./_annotations";
import { corridorEntry, corridorLine } from "./_corridors";
import { prefixedErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import {
  kmInput,
  placeText,
  routeBuildEnv,
  routeErrorResult,
} from "./_storedRoutes";
import { CorridorResultOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "manage-corridors";

const description = `
Saves, renames, flips or deletes a running corridor: a named line the
athlete runs again and again, kept as a stored route. For "save km 3-5.4 of
Sunday's run as Glebe foreshore", "call it the bay run instead", "that one
is one-way" or "forget that corridor". list-corridors to see them and to
find stretches worth saving; view-route-map with a corridor's route_id
draws it; amend-route reverse flips one.

Actions:
- add: needs name and one source, activity (a past run's km range, or two
  places it passes as from and to) or route (a stored route's km range).
  The same stretch added twice returns the saved one and changes nothing.
- rename: needs route_id and name; a name another corridor has is refused.
- set_one_way: needs route_id and one_way (true when it is only run in one
  direction).
- delete: needs route_id. Deletes the saved corridor for good; the runs it
  came from stay.

Notes:
- route_id is a corridor id (starts with c); other stored routes are
  refused.
- A corridor is at least 200 m. Places in from and to are sent to
  OpenRouteService for lookup.
`;

const inputSchema = z.object({
  action: z.enum(["add", "rename", "set_one_way", "delete"]),
  route_id: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe(
      "The corridor, for rename, set_one_way and delete (starts with c)",
    ),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("The corridor's name, for add and rename"),
  one_way: z
    .boolean()
    .optional()
    .describe("Set for set_one_way; optional on add (default false)"),
  activity: z
    .strictObject({
      id: intervalsActivityIdInput("The past run to take the corridor from.", {
        allowLatest: false,
      }),
      from_km: kmInput("Its own km to start at; default 0").optional(),
      to_km: kmInput("Its own km to end at; default its end").optional(),
      from: placeText
        .optional()
        .describe("A place the run passes where the corridor starts; with to"),
      to: placeText
        .optional()
        .describe("A place the run passes after from, where it ends"),
    })
    .optional()
    .describe("add: take it from a past run"),
  route: z
    .strictObject({
      route_id: z.string().trim().max(40).describe("A stored route"),
      version: z.number().int().positive().optional(),
      from_km: kmInput("Its km to start at; default 0").optional(),
      to_km: kmInput("Its km to end at; default its end").optional(),
    })
    .optional()
    .describe("add: take it from a stored route"),
});

type ManageCorridorsInput = z.infer<typeof inputSchema>;

const refuse = (message: string) => ({
  content: [{ type: "text" as const, text: prefixedErrorText(message) }],
  isError: true as const,
});

/** The first thing the action needs that the call lacks, or null. */
function missing(a: ManageCorridorsInput): string | null {
  if (a.action === "add") {
    if (!a.name) return "add needs name.";
    if (!a.activity === !a.route)
      return "add needs exactly one of activity and route.";
    if (a.route && !isRouteId(a.route.route_id))
      return "route.route_id is not a stored route id.";
  } else if (!a.route_id) return `${a.action} needs route_id.`;
  else if (a.action === "rename" && !a.name) return "rename needs name.";
  else if (a.action === "set_one_way" && a.one_way === undefined)
    return "set_one_way needs one_way.";
  return null;
}

export const manageCorridorsTool = {
  name,
  title: "Manage running corridors",
  description,
  inputSchema,
  annotations: WRITE_DESTRUCTIVE,
  outputSchema: CorridorResultOutputSchema,
  execute: async (
    args: ManageCorridorsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const problem = missing(args);
    if (problem) return refuse(problem);
    try {
      const warnings: string[] = [];
      let corridor: ReturnType<typeof corridorEntry> | null = null;
      let created = false;
      let text: string;
      if (args.action === "add") {
        const source: CorridorSource = args.activity
          ? { type: "activity", ...args.activity }
          : { type: "route", ...args.route! };
        const added = await addCorridor(
          apiKey,
          { name: args.name!, one_way: args.one_way, source },
          routeBuildEnv(),
          progress,
        );
        created = added.created;
        corridor = corridorEntry(added.route, null, null);
        text = created
          ? `Saved corridor ${corridorLine(corridor)}`
          : `This stretch was already saved as corridor ${corridorLine(corridor)}. Nothing changed.`;
      } else {
        const id = args.route_id!;
        // Rejects a crafted id before it reaches a file path; a non-corridor id is refused by the store.
        if (!isRouteId(id) || !id.startsWith("c"))
          throw new CorridorNotFoundError(id);
        if (args.action === "delete") {
          await deleteCorridor(id);
          text = `Deleted corridor ${id}.`;
        } else {
          if (args.action === "rename") {
            const key = corridorKey(args.name!);
            if (!key) return refuse("A corridor name needs at least one word.");
            const taken = (await listCorridors()).find(
              (c) => c.route_id !== id && corridorKey(c.name) === key,
            );
            if (taken)
              return refuse(
                `A corridor named "${taken.name}" is already saved (${taken.route_id}); pick another name.`,
              );
          }
          const updated = await updateCorridor(
            id,
            args.action === "rename"
              ? { name: args.name }
              : { one_way: args.one_way },
          );
          corridor = corridorEntry(updated, null, null);
          text = `Updated corridor ${corridorLine(corridor)}`;
        }
      }
      const structured = {
        action: args.action,
        corridor,
        created,
        deleted: args.action === "delete",
        warnings,
      };
      warnOnSchemaDrift(name, CorridorResultOutputSchema, structured);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: structured,
      };
    } catch (error) {
      return routeErrorResult(error, "manage corridors");
    }
  },
};
