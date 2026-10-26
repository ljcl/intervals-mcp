import { z } from "zod";
import { getTimeZone } from "../config";
import {
  getWellnessDay,
  type IntervalsWellness,
  updateWellness as putWellness,
} from "../intervalsClient";
import {
  composeDescription,
  discardedDescription,
} from "../utils/activityWrite";
import { dateInputSchema, todayLocal } from "../utils/localDate";
import {
  buildWellnessPatch,
  currentWellnessFields,
  diffWellnessWrite,
  type RequestedWellnessFields,
  WELLNESS_SCORE_NAMES,
  WELLNESS_SCORES,
  type WellnessScore,
  type WellnessWriteChange,
  wellnessScoreLabel,
} from "../utils/wellnessWrite";
import { WRITE_DESTRUCTIVE } from "./_annotations";
import {
  isDefiniteWriteRejection,
  noteToolFailure,
  toolErrorText,
} from "./_errors";
import { mapWellnessDay } from "./getWellness";
import { WellnessWriteOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "update-wellness";

const description = `
Logs how the athlete feels on one day in intervals.icu wellness: soreness,
fatigue, stress, mood, motivation, injury, sleep quality and comments. It
writes data: confirm the exact change with the athlete first. To read the
day back, use get-wellness. For one run's RPE or feel, use update-activity.

Notes:
- Give at least one score or comments. Each score is 1 to 4, and 1 is the
  best state; null clears it.
- With no date it writes today. A date after today is refused.
- With no commentsMode, comments that would overwrite the day's comments
  fail and write nothing.
- It reads the day fresh, sends only the fields that differ in one PUT
  (never retried), then re-reads and echoes before and after values. Device
  fields (HRV, resting HR, sleep time, weight) are never sent.
- A day locked in intervals.icu does not take API changes: the reply warns
  for each value that was not applied.
- If the write times out, or anything fails after it was sent, the day may
  already be updated. The response says so: check with get-wellness before
  sending the same update again.
`;

function scoreInput(scale: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(4)
    .nullable()
    .optional()
    .describe(`${scale}. null clears it.`);
}

const inputSchema = z
  .object({
    date: dateInputSchema
      .optional()
      .describe("The day to log (YYYY-MM-DD). Defaults to today."),
    soreness: scoreInput(
      "Muscle soreness: 1 low, 2 average, 3 high, 4 extreme",
    ),
    fatigue: scoreInput("Fatigue: 1 low, 2 average, 3 high, 4 extreme"),
    stress: scoreInput("Stress: 1 low, 2 average, 3 high, 4 extreme"),
    mood: scoreInput("Mood: 1 great, 2 good, 3 OK, 4 grumpy"),
    motivation: scoreInput("Motivation: 1 extreme, 2 high, 3 average, 4 low"),
    injury: scoreInput("Injury: 1 none, 2 niggle, 3 poor, 4 injured"),
    sleepQuality: scoreInput(
      "Sleep quality: 1 great, 2 good, 3 average, 4 poor",
    ),
    comments: z
      .string()
      .optional()
      .describe(
        "Comments text to set or add to the day, e.g. 'left calf tight'. In replace mode, an empty string clears the comments.",
      ),
    commentsMode: z
      .enum(["replace", "append"])
      .optional()
      .describe(
        "How to apply `comments`. 'replace' overwrites the day's comments, and an empty string clears them; 'append' adds a blank line then the new text below them, and rejects an empty or whitespace-only value. Requires `comments` to be set.",
      ),
  })
  .superRefine((data, ctx) => {
    if (data.commentsMode !== undefined && data.comments === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["commentsMode"],
        message: "commentsMode requires comments to also be set.",
      });
    }
    if (
      data.comments !== undefined &&
      data.commentsMode === "append" &&
      data.comments.trim() === ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["comments"],
        message:
          "comments must not be empty or whitespace-only in append mode. Use commentsMode 'replace' with an empty string to clear the comments instead.",
      });
    }
  });

type UpdateWellnessInput = z.infer<typeof inputSchema>;

const COMMENTS_PREVIEW_CHARS = 120;

/** A comments text as its length and a short preview, as update-activity
 * shows a description. */
function formatCommentsPreview(text: string): string {
  const preview =
    text.length > COMMENTS_PREVIEW_CHARS
      ? `${text.slice(0, COMMENTS_PREVIEW_CHARS)}...`
      : text;
  return `${text.length} chars ("${preview}")`;
}

const SCORE_BY_OUTPUT = new Map<string, WellnessScore>(
  WELLNESS_SCORE_NAMES.map((score) => [WELLNESS_SCORES[score].output, score]),
);

function formatScoreValue(
  score: WellnessScore,
  value: string | number | null,
): string {
  if (value === null) return "nothing";
  const label = wellnessScoreLabel(score, Number(value));
  return label ? `${value} (${label})` : String(value);
}

function formatChangeSummary(change: WellnessWriteChange): string {
  const score = SCORE_BY_OUTPUT.get(change.field);
  const label = change.field.replace("_", " ");
  if (score) {
    return `${label} to ${formatScoreValue(score, change.after)} (was ${formatScoreValue(score, change.before)})`;
  }
  if (change.after === null || change.after === "") return "comments cleared";
  return `comments to ${formatCommentsPreview(String(change.after))}`;
}

function toOutput(
  date: string,
  day: IntervalsWellness,
  changes: WellnessWriteChange[],
  warnings: string[],
) {
  return {
    date,
    locked: day.locked === true,
    // The record's own id is its date; a day with no record answers with it
    // too, but the requested date is the one the athlete named.
    day: { ...mapWellnessDay(day), date },
    changes,
    warnings,
  };
}

export const updateWellnessTool = {
  name,
  title: "Update wellness",
  description,
  inputSchema,
  annotations: WRITE_DESTRUCTIVE,
  outputSchema: WellnessWriteOutputSchema,
  execute: async (input: UpdateWellnessInput, apiKey: string) => {
    const { date: rawDate, comments, commentsMode } = input;
    const requestedScores = WELLNESS_SCORE_NAMES.filter(
      (score) => input[score] !== undefined,
    );

    if (requestedScores.length === 0 && comments === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Nothing to update: provide at least one of ${WELLNESS_SCORE_NAMES.join(", ")} or comments.`,
          },
        ],
        isError: true,
      };
    }

    const today = todayLocal(getTimeZone());
    const date = rawDate ?? today;
    if (date > today) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ ${date} is after today (${today}). Log wellness for today or an earlier day.`,
          },
        ],
        isError: true,
      };
    }

    // Tracks whether the PUT itself resolved: once true, any later failure
    // means the write cannot be confirmed, not that it failed.
    let written = false;

    try {
      // Fresh read: a day with no record still answers, with every field
      // null (docs/api-notes.md).
      const before = await getWellnessDay(apiKey, date, { skipCache: true });
      const beforeFields = currentWellnessFields(before);

      // With no commentsMode, never drop comments already on the day.
      const unconfirmedLoss =
        comments !== undefined && commentsMode === undefined
          ? discardedDescription(beforeFields.comments, comments)
          : null;
      if (unconfirmedLoss !== null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ Wellness for ${date} was not updated. The day already has comments that the new text would overwrite: ${formatCommentsPreview(unconfirmedLoss)}. Set commentsMode to "append" to keep them and add the new text below, or to "replace" to overwrite them.`,
            },
          ],
          isError: true,
        };
      }

      const requested: RequestedWellnessFields = {};
      for (const score of requestedScores) requested[score] = input[score];
      if (comments !== undefined) {
        requested.comments = composeDescription(
          before.comments,
          comments,
          commentsMode ?? "replace",
        );
      }

      const patch = buildWellnessPatch(requested, beforeFields);

      if (Object.keys(patch).length === 0) {
        const structured = toOutput(date, before, [], []);
        warnOnSchemaDrift(name, WellnessWriteOutputSchema, structured);
        return {
          content: [
            {
              type: "text" as const,
              text: `No change: wellness for ${date} already matches the requested values.`,
            },
          ],
          structuredContent: structured,
        };
      }

      try {
        await putWellness(apiKey, date, patch);
      } catch (putError) {
        if (isDefiniteWriteRejection(putError)) throw putError;
        const detail =
          putError instanceof Error ? putError.message : String(putError);
        noteToolFailure(putError);
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ The update to wellness for ${date} may already have been applied (${detail}). Check with get-wellness before retrying; do not resend the same update blindly.`,
            },
          ],
          isError: true,
        };
      }
      written = true;

      const after = await getWellnessDay(apiKey, date, { skipCache: true });
      const { changes, warnings } = diffWellnessWrite(
        patch,
        beforeFields,
        currentWellnessFields(after),
      );
      if (warnings.length > 0 && after.locked === true) {
        warnings.push(
          `The day is locked in intervals.icu, which stops API changes. To log it, unlock the day in the intervals.icu wellness dialog, then try again.`,
        );
      }

      const structured = toOutput(date, after, changes, warnings);
      warnOnSchemaDrift(name, WellnessWriteOutputSchema, structured);

      // Some hosts drop structuredContent, so replaced comments are quoted
      // here too. Compared with the re-read, so a replace that did not
      // apply claims no loss.
      const removed =
        patch.comments !== undefined
          ? discardedDescription(beforeFields.comments, after.comments)
          : null;
      const removedText =
        removed !== null
          ? ` Removed the previous comments: ${formatCommentsPreview(removed)}.`
          : "";
      const warningText =
        warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated wellness for ${date}: ${changes.map(formatChangeSummary).join(", ")}.${removedText}${warningText}`,
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
              text: `❌ The update to wellness for ${date} was sent and may have been applied, but confirming it afterward failed: ${detail}. Check with get-wellness before retrying; do not resend the same update blindly.`,
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
              context: `update wellness for ${date}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
