import { z } from "zod";
import {
  getActivity as fetchActivity,
  type IntervalsActivity,
  type IntervalsActivityUpdate,
  type IntervalsGear,
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
  discardedDescription,
  findGear,
  isGearRetired,
} from "../utils/activityWrite";
import { WRITE_DESTRUCTIVE } from "./_annotations";
import {
  confirmWrite,
  quoteForConfirmation,
  type WriteConfirmContext,
} from "./_confirm";
import {
  isDefiniteWriteRejection,
  noteToolFailure,
  toolErrorText,
} from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { resolveActivityGearName } from "./getActivity";
import {
  ActivityWriteOutputSchema,
  toActivityWriteOutput,
  warnOnSchemaDrift,
} from "./outputs";

const name = "update-activity";

const description = `
Updates one intervals.icu activity's name, description, gear, RPE or feel.
It writes data: confirm the change with the athlete first. To log how the
athlete feels on a day, use update-wellness.
To add a note, use descriptionMode "append" so the existing description
stays.

Notes:
- Give at least one of name, description, gearId, rpe or feel.
- With no descriptionMode, a call that would overwrite an existing
  description fails and writes nothing.
- It reads the activity fresh, sends only the fields that differ in one PUT
  (never retried), then re-reads and echoes before and after values.
- With descriptionMode "replace", a host that supports elicitation asks the
  athlete to confirm the old and new text before any text is dropped. A
  decline writes nothing; do not resend unless the athlete asks.
- gearId is checked against the current gear list: an unknown id fails and
  lists the valid ones, a retired id is accepted with a warning. Gear can be
  switched but not cleared.
- If the write times out, or anything fails after it was sent, the activity
  may already be updated. The response says so: check with get-activity
  before sending the same update again.
`;

const inputSchema = z
  .object({
    id: intervalsActivityIdInput("The intervals.icu activity id to update.", {
      allowLatest: false,
    }),
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
        'How the activity felt, 1 to 5 on intervals.icu\'s scale: 1 is the strongest feeling ("Strong"), 5 the weakest.',
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
 * Shows a description as its length and a short preview, so a long note
 * does not dominate a one-line reply. The full text of a written change is
 * already in `structuredContent.changes`.
 */
function formatDescriptionPreview(text: string): string {
  const preview =
    text.length > DESCRIPTION_PREVIEW_CHARS
      ? `${text.slice(0, DESCRIPTION_PREVIEW_CHARS)}...`
      : text;
  return `${text.length} chars ("${preview}")`;
}

/** A gear id with its name, as get-activity's text shows it. */
function formatGear(id: string | number | null, gearName?: string | null) {
  if (id === null) return "no gear";
  return gearName ? `"${gearName}" [${id}]` : `"${id}"`;
}

function formatChangeSummary(change: ActivityWriteChange): string {
  if (change.field === "gear") {
    return `gear to ${formatGear(change.after, change.after_name)} (was ${formatGear(change.before, change.before_name)})`;
  }
  if (change.field !== "description") {
    return `${change.field} to ${formatChangeValue(change.after)}`;
  }
  if (change.after === null) return "description to nothing";
  return `description to ${formatDescriptionPreview(String(change.after))}`;
}

/**
 * The name of the gear `activity` shows, or null. The activity payload
 * never names its gear (docs/api-notes.md), so the name comes from the gear
 * list: the fresh one a `gearId` request already read, else get-activity's
 * own cached read. It names the gear the activity actually has, so a gear
 * change that did not apply never claims the requested name. Never throws:
 * a failed read leaves the name null and the write's result stands.
 */
async function gearNameOf(
  apiKey: string,
  activity: IntervalsActivity,
  gearList: IntervalsGear[] | undefined,
): Promise<string | null> {
  const id = activity.gear?.id;
  if (!id) return null;
  const listed = gearList ? findGear(id, gearList) : undefined;
  if (listed) return listed.name ?? null;
  return resolveActivityGearName(apiKey, activity);
}

/**
 * Adds the gear names to a gear change, so the reply names the shoes
 * rather than only their ids (`before_name`, `after_name`).
 */
async function withGearNames(
  changes: ActivityWriteChange[],
  apiKey: string,
  before: IntervalsActivity,
  afterName: string | null,
  gearList: IntervalsGear[] | undefined,
): Promise<ActivityWriteChange[]> {
  if (!changes.some((change) => change.field === "gear")) return changes;
  const beforeName = await gearNameOf(apiKey, before, gearList);
  return changes.map((change) =>
    change.field === "gear"
      ? { ...change, before_name: beforeName, after_name: afterName }
      : change,
  );
}

/** The warning a declined confirmation leaves (#417). */
const DECLINED_WARNING =
  "The athlete declined the change when the host asked to confirm it, so nothing was sent.";

/** The other fields a confirmed replace also writes, one line each. */
function otherChangeLines(patch: IntervalsActivityUpdate): string[] {
  const lines: string[] = [];
  if (patch.name !== undefined) lines.push(`Name: "${patch.name}"`);
  if (patch.gear !== undefined) lines.push(`Gear: ${patch.gear.id}`);
  if (patch.icu_rpe !== undefined) lines.push(`RPE: ${patch.icu_rpe}`);
  if (patch.feel !== undefined) lines.push(`Feel: ${patch.feel}`);
  return lines;
}

/** The confirmation's text: the description lost, its replacement, and
 * anything else the same write changes. */
function replaceMessage(
  id: string,
  before: IntervalsActivity,
  patch: IntervalsActivityUpdate,
): string {
  const others = otherChangeLines(patch);
  return [
    `Replace the description of activity ${id} ("${before.name ?? id}")? The current description will be removed.`,
    `Current description:\n${quoteForConfirmation(before.description)}`,
    `New description:\n${quoteForConfirmation(patch.description)}`,
    ...(others.length > 0 ? [`Also changes:\n${others.join("\n")}`] : []),
  ].join("\n\n");
}

export const updateActivityTool = {
  name,
  title: "Update activity",
  description,
  inputSchema,
  annotations: WRITE_DESTRUCTIVE,
  outputSchema: ActivityWriteOutputSchema,
  execute: async (
    input: UpdateActivityInput,
    apiKey: string,
    _progress?: unknown,
    context?: WriteConfirmContext,
  ) => {
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

      // With no descriptionMode, never drop text already on the activity
      // (race notes, a coach's comment, a plan's workout summary). Checked
      // before the gear read, so a refused call sends no further request.
      const unconfirmedLoss =
        newDescription !== undefined && descriptionMode === undefined
          ? discardedDescription(beforeFields.description, newDescription)
          : null;
      if (unconfirmedLoss !== null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ Activity ${id} was not updated. It already has a description that the new text would overwrite: ${formatDescriptionPreview(unconfirmedLoss)}. Set descriptionMode to "append" to keep it and add the new text below, or to "replace" to overwrite it.`,
            },
          ],
          isError: true,
        };
      }

      let gearWarning: string | undefined;
      let gearList: IntervalsGear[] | undefined;

      if (gearId !== undefined) {
        // Fresh (skipCache) so gear added moments ago is accepted.
        gearList = await listGear(apiKey, { skipCache: true });
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
        if (isGearRetired(match.retired)) {
          gearWarning = `Gear ${match.id} (${match.name ?? "unnamed"}) is retired.`;
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
          await gearNameOf(apiKey, before, gearList),
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

      // An explicit replace that drops text: a host that can show a form
      // confirms the before and after with the athlete first (#417).
      const replaced =
        descriptionMode === "replace" && patch.description !== undefined
          ? discardedDescription(beforeFields.description, patch.description)
          : null;
      if (replaced !== null) {
        const confirmation = confirmWrite(context, {
          message: replaceMessage(id, before, patch),
          label: "Replace the description",
          change: { tool: name, id, before: replaced, patch },
        });
        if (confirmation.status === "ask") {
          return { content: [], inputRequired: confirmation.result };
        }
        if (confirmation.status === "declined") {
          const structured = toActivityWriteOutput(
            before,
            [],
            [DECLINED_WARNING],
            await gearNameOf(apiKey, before, gearList),
          );
          warnOnSchemaDrift(name, ActivityWriteOutputSchema, structured);
          return {
            content: [
              {
                type: "text" as const,
                text: `Activity ${id} was not updated: ${DECLINED_WARNING} Do not send it again unless the athlete asks.`,
              },
            ],
            structuredContent: structured,
          };
        }
      }

      try {
        await putActivity(apiKey, id, patch);
      } catch (putError) {
        // A rejection that never reached the write (a 4xx such as a bad gear
        // id, a RateLimitError, a CallCancelledError) takes the normal error
        // path. Anything else leaves the write's outcome unknown, so it gets
        // the honest "may already have been applied" text rather than either
        // a flat failure or a silent success.
        if (isDefiniteWriteRejection(putError)) {
          throw putError;
        }
        const detail =
          putError instanceof Error ? putError.message : String(putError);
        noteToolFailure(putError);
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

      const diff = diffActivityWrite(patch, beforeFields, afterFields);
      const { warnings } = diff;
      if (gearWarning) warnings.unshift(gearWarning);
      const gearName = await gearNameOf(apiKey, after, gearList);
      const changes = await withGearNames(
        diff.changes,
        apiKey,
        before,
        gearName,
        gearList,
      );

      const structured = toActivityWriteOutput(
        after,
        changes,
        warnings,
        gearName,
      );
      warnOnSchemaDrift(name, ActivityWriteOutputSchema, structured);

      const summary = changes.map(formatChangeSummary).join(", ");
      // Some hosts drop structuredContent, and with it changes[].before, so
      // text an explicit replace dropped is quoted here too. Compared with
      // the re-read, so a replace that did not apply claims no loss.
      const removed =
        patch.description !== undefined
          ? discardedDescription(
              beforeFields.description,
              afterFields.description,
            )
          : null;
      const removedText =
        removed !== null
          ? ` Removed the previous description: ${formatDescriptionPreview(removed)}.`
          : "";
      const warningText =
        warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated activity ${id} ("${after.name ?? id}"): ${summary}.${removedText}${warningText}`,
          },
        ],
        structuredContent: structured,
      };
    } catch (error) {
      if (written) {
        const detail = error instanceof Error ? error.message : String(error);
        noteToolFailure(error);
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
