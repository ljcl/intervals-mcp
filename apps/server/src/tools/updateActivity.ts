import { z } from "zod";
import {
  getActivity as fetchActivity,
  type IntervalsActivity,
  listGear,
  updateActivity as putActivity,
} from "../intervalsClient";
import {
  type ActivityWriteChange,
  buildActivityPatch,
  type CurrentActivityFields,
  composeDescription,
  describeGearOptions,
  diffActivityWrite,
  findGear,
  isGearRetired,
} from "../utils/activityWrite";
import { WRITE_DESTRUCTIVE } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import {
  ActivityWriteOutputSchema,
  toActivityWriteOutput,
  warnOnSchemaDrift,
} from "./outputs";

const name = "update-activity";

const description = `
Updates an intervals.icu activity's name, description, gear, RPE, or feel.

Reads the activity fresh, writes only the fields that actually differ from
the current value in a single PUT (never retried, even on a 5xx), then
re-reads fresh and echoes before/after values for every field that changed.

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities
- name (optional): new title
- description (optional): text to set; descriptionMode controls how
- descriptionMode (optional): "replace" (default) overwrites the existing description; "append" keeps it and adds the new text below it, separated by a blank line
- gearId (optional): gear id to assign, from list-gear; an unknown id fails and lists the available gear ids and names; a retired gear id is accepted with a warning
- rpe (optional): session RPE, integer 1 to 10, maps to icu_rpe
- feel (optional): integer 1 to 5; on intervals.icu's scale 1 is the strongest feeling and 5 the weakest (to be confirmed by a live check)

At least one of name, description, gearId, rpe, or feel is required.
Gear can be switched but not cleared: intervals.icu ignores a null gear id.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id to update."),
  name: z.string().optional().describe("New activity title."),
  description: z
    .string()
    .optional()
    .describe("Description text to set or add to the activity."),
  descriptionMode: z
    .enum(["replace", "append"])
    .optional()
    .describe(
      "How to apply `description`. 'replace' (default) overwrites the existing description; 'append' adds a blank line then the new text below it.",
    ),
  gearId: z
    .string()
    .optional()
    .describe("Gear id to assign, e.g. 'g123456', from list-gear."),
  rpe: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Session RPE, 1 (easiest) to 10 (hardest). Maps to icu_rpe."),
  feel: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "How the activity felt, 1 to 5 on intervals.icu's scale: 1 is the strongest feeling, 5 the weakest (to be confirmed by a live check).",
    ),
});

type UpdateActivityInput = z.infer<typeof inputSchema>;

function toFields(activity: IntervalsActivity): CurrentActivityFields {
  return {
    name: activity.name ?? null,
    description: activity.description ?? null,
    gearId: activity.gear?.id ?? null,
    rpe: activity.icu_rpe ?? null,
    feel: activity.feel ?? null,
  };
}

function formatChangeValue(value: string | number | null): string {
  return value === null ? "nothing" : `"${value}"`;
}

export const updateActivityTool = {
  name,
  description,
  inputSchema,
  annotations: WRITE_DESTRUCTIVE,
  outputSchema: ActivityWriteOutputSchema,
  execute: async (input: UpdateActivityInput, apiKey: string) => {
    const {
      id,
      name: newName,
      description: newDescription,
      descriptionMode,
      gearId,
      rpe,
      feel,
    } = input;

    const hasMutation =
      newName !== undefined ||
      newDescription !== undefined ||
      gearId !== undefined ||
      rpe !== undefined ||
      feel !== undefined;

    if (!hasMutation) {
      return {
        content: [
          {
            type: "text" as const,
            text: "❌ Nothing to update: provide at least one of name, description, gearId, rpe, or feel.",
          },
        ],
        isError: true,
      };
    }

    try {
      let gearWarning: string | undefined;
      let gearName: string | null | undefined;

      if (gearId !== undefined) {
        const gearList = await listGear(apiKey);
        const match = findGear(gearId, gearList);
        if (!match) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ Unknown gear id "${gearId}" for activity ${id}. Available gear: ${describeGearOptions(gearList)}.`,
              },
            ],
            isError: true,
          };
        }
        gearName = match.name ?? null;
        if (isGearRetired(match.retired)) {
          gearWarning = `Gear ${match.id} (${gearName ?? "unnamed"}) is retired.`;
        }
      }

      // Fresh read: a cached description would be stale to append onto, and
      // a cached gear/rpe/feel would make the "skip unchanged fields" patch
      // wrong.
      const before = await fetchActivity(apiKey, id, { skipCache: true });
      const beforeFields = toFields(before);

      const resolvedDescription =
        newDescription !== undefined
          ? composeDescription(
              before.description,
              newDescription,
              descriptionMode ?? "replace",
            )
          : undefined;

      const patch = buildActivityPatch(
        {
          name: newName,
          description: resolvedDescription,
          gearId,
          rpe,
          feel,
        },
        beforeFields,
      );

      if (Object.keys(patch).length === 0) {
        const structured = toActivityWriteOutput(
          before,
          [],
          gearWarning ? [gearWarning] : [],
          gearName,
        );
        warnOnSchemaDrift(name, ActivityWriteOutputSchema, structured);
        return {
          content: [
            {
              type: "text" as const,
              text: `No change: activity ${id} already matches the requested values.`,
            },
          ],
          structuredContent: structured,
        };
      }

      await putActivity(apiKey, id, patch);

      // Fresh re-read: confirms what intervals.icu actually stored, rather
      // than trusting the PUT response or the pre-write read.
      const after = await fetchActivity(apiKey, id, { skipCache: true });
      const afterFields = toFields(after);

      const {
        changes,
        warnings,
      }: {
        changes: ActivityWriteChange[];
        warnings: string[];
      } = diffActivityWrite(patch, beforeFields, afterFields);
      if (gearWarning) warnings.unshift(gearWarning);

      const structured = toActivityWriteOutput(
        after,
        changes,
        warnings,
        gearName,
      );
      warnOnSchemaDrift(name, ActivityWriteOutputSchema, structured);

      const summary = changes
        .map((c) => `${c.field} to ${formatChangeValue(c.after)}`)
        .join(", ");
      const warningText =
        warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated activity ${id} ("${after.name ?? id}"): ${summary}.${warningText}`,
          },
        ],
        structuredContent: structured,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `update activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
