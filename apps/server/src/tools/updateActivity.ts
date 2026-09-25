import { z } from "zod";
import { HttpError, RateLimitError } from "../fetchClient";
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
- name (optional): new title; must not be empty or whitespace-only
- description (optional): text to set; descriptionMode controls how. In replace mode (the default), an empty string is the explicit way to clear the description. In append mode, an empty or whitespace-only value is rejected
- descriptionMode (optional): "replace" (default) overwrites the existing description; "append" keeps it and adds the new text below it, separated by a blank line. Requires description to also be set
- gearId (optional): gear id to assign, validated fresh against list-gear; an unknown id fails and lists the available gear ids and names; a retired gear id is accepted with a warning
- rpe (optional): session RPE, integer 1 to 10, maps to icu_rpe
- feel (optional): integer 1 to 5; on intervals.icu's scale 1 is the strongest feeling and 5 the weakest (assumed; not exercised by the live write check)

At least one of name, description, gearId, rpe, or feel is required.
Gear can be switched but not cleared: intervals.icu ignores a null gear id.

If the write itself times out, or anything fails after it was sent (the
confirming re-read, for instance), the activity may already have been
updated: the response says so and asks to check with get-activity before
sending the same update again, rather than retrying blindly.
`;

const inputSchema = z
  .object({
    id: intervalsActivityIdInput("The intervals.icu activity id to update."),
    name: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "name must not be empty or whitespace-only.",
      })
      .optional()
      .describe("New activity title. Must not be empty or whitespace-only."),
    description: z
      .string()
      .optional()
      .describe(
        "Description text to set or add to the activity. In replace mode, an empty string explicitly clears the description.",
      ),
    descriptionMode: z
      .enum(["replace", "append"])
      .optional()
      .describe(
        "How to apply `description`. 'replace' (default) overwrites the existing description, and an empty string clears it; 'append' adds a blank line then the new text below it, and rejects an empty or whitespace-only value. Requires `description` to be set.",
      ),
    gearId: z
      .string()
      .optional()
      .describe("Gear id to assign, e.g. '12345', from list-gear."),
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
        "How the activity felt, 1 to 5 on intervals.icu's scale: 1 is the strongest feeling, 5 the weakest (assumed; not exercised by the live write check).",
      ),
  })
  .superRefine((data, ctx) => {
    if (data.descriptionMode !== undefined && data.description === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["descriptionMode"],
        message: "descriptionMode requires description to also be set.",
      });
    }
    if (
      data.description !== undefined &&
      (data.descriptionMode ?? "replace") === "append" &&
      data.description.trim() === ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message:
          "description must not be empty or whitespace-only in append mode. Use descriptionMode 'replace' with an empty string to clear the description instead.",
      });
    }
  });

type UpdateActivityInput = z.infer<typeof inputSchema>;

const DESCRIPTION_PREVIEW_CHARS = 120;

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

/**
 * The description's full text is already in `structuredContent.changes`; the
 * text response shows only its length and a short preview so a long note
 * does not dominate the summary line.
 */
function formatChangeSummary(change: ActivityWriteChange): string {
  if (change.field !== "description") {
    return `${change.field} to ${formatChangeValue(change.after)}`;
  }
  if (change.after === null) return "description to nothing";
  const text = String(change.after);
  const preview =
    text.length > DESCRIPTION_PREVIEW_CHARS
      ? `${text.slice(0, DESCRIPTION_PREVIEW_CHARS)}...`
      : text;
  return `description to ${text.length} chars ("${preview}")`;
}

/**
 * `gearName` (resolved from a fresh `list-gear` call) is only trustworthy
 * when the activity's own gear id actually matches what was requested;
 * otherwise the not-applied warning already covers it and echoing the
 * requested name here would claim gear that was never assigned.
 */
function resolveAppliedGearName(
  requestedGearId: string | undefined,
  resolvedName: string | null | undefined,
  actualGearId: string | null,
): string | null | undefined {
  if (requestedGearId === undefined) return undefined;
  return actualGearId === requestedGearId ? (resolvedName ?? null) : null;
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

    // Tracks whether the PUT itself resolved: once true, any later failure
    // (the confirming re-read, or parsing its response) does not mean the
    // write failed. It means we can no longer confirm what intervals.icu
    // actually stored, which is a different, more cautious message.
    let written = false;

    try {
      // Fresh read first, before gear validation, so a 404 activity is
      // reported as not-found rather than as an unknown-gear error.
      const before = await fetchActivity(apiKey, id, { skipCache: true });
      const beforeFields = toFields(before);

      let gearWarning: string | undefined;
      let gearName: string | null | undefined;

      if (gearId !== undefined) {
        // Fresh (skipCache) so gear added moments ago is accepted.
        const gearList = await listGear(apiKey, { skipCache: true });
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
          resolveAppliedGearName(gearId, gearName, beforeFields.gearId),
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

      try {
        await putActivity(apiKey, id, patch);
      } catch (putError) {
        // A 4xx (the request itself was rejected, e.g. a bad gear id) or a
        // RateLimitError (throttled before it ran) never reached the write,
        // so rethrow for the normal error path. Anything else (a timeout, a 5xx,
        // a network fault, or the client failing to parse an otherwise-200
        // response) leaves the write's outcome unknown, so it gets the same
        // honest "may already have been applied" text rather than either a
        // flat failure or a silent success.
        const isDefiniteRejection =
          putError instanceof RateLimitError ||
          (putError instanceof HttpError &&
            putError.response.status >= 400 &&
            putError.response.status < 500);
        if (isDefiniteRejection) {
          throw putError;
        }
        const detail =
          putError instanceof Error ? putError.message : String(putError);
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ The update to activity ${id} may already have been applied (${detail}). Check with get-activity before retrying; do not resend the same update blindly.`,
            },
          ],
          isError: true,
        };
      }
      written = true;

      // Fresh re-read: confirms what intervals.icu actually stored, rather
      // than trusting the pre-write read.
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
        resolveAppliedGearName(gearId, gearName, afterFields.gearId),
      );
      warnOnSchemaDrift(name, ActivityWriteOutputSchema, structured);

      const summary = changes.map(formatChangeSummary).join(", ");
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
      if (written) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ The update to activity ${id} was sent and may have been applied, but confirming it afterward failed: ${detail}. Check with get-activity before retrying; do not resend the same update blindly.`,
            },
          ],
          isError: true,
        };
      }
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
