/**
 * The athlete's "ignore" marks on an activity (#510): the one home of what
 * the stream tools say about them.
 *
 * In intervals.icu the athlete can mark an activity's heart rate, pace or
 * time, or a part of it, as data to ignore. A live check (docs/api-notes.md,
 * 2026-11-19) showed what that changes: nothing in the activity's own
 * numbers. Its average and maximum heart rate, zone times, load, pace, GAP,
 * intervals and every stream stay as they were. Only the activity's HR
 * curve (for an ignored part with `hr`) and pace curve (with `pace`) leave
 * the part out.
 *
 * So the tools do not remove the data either: a number computed without it
 * would disagree with the number intervals.icu shows for the same activity.
 * They say that the athlete marked it, which is what a reader needs to
 * judge the number. get-best-efforts is the one tool that leaves an ignored
 * part out (`paceIgnoredMask`), because it is this server's pace curve.
 */
import { z } from "zod";

/** The flags and parts this module reads, all optional and nullable. */
export interface IgnoreMarks {
  icu_ignore_hr?: boolean | null;
  icu_ignore_time?: boolean | null;
  ignore_pace?: boolean | null;
  ignore_velocity?: boolean | null;
  ignore_parts?: unknown;
}

const PartsSchema = z.array(
  z
    .object({
      hr: z.boolean().nullable().optional(),
      pace: z.boolean().nullable().optional(),
    })
    .passthrough(),
);

const partsText = (count: number) =>
  `${count} ${count === 1 ? "part" : "parts"}`;

/**
 * One warning for each mark that touches data the caller reads (`uses`).
 * Empty for an activity with no mark, which is nearly every activity.
 */
export function ignoreWarnings(
  activity: IgnoreMarks,
  uses: { hr: boolean; pace: boolean },
): string[] {
  const parsed = PartsSchema.safeParse(activity.ignore_parts);
  const parts = parsed.success ? parsed.data : [];
  const hrParts = parts.filter((part) => part.hr === true).length;
  const paceParts = parts.filter((part) => part.pace === true).length;
  const kept =
    "intervals.icu keeps it in the activity's own numbers, and so do the numbers here";
  const warnings: string[] = [];
  if (uses.hr) {
    if (activity.icu_ignore_hr === true) {
      warnings.push(
        `You marked this activity's heart rate to ignore in intervals.icu. ${kept}: read each heart-rate number as not reliable.`,
      );
    } else if (hrParts > 0) {
      warnings.push(
        `You marked ${partsText(hrParts)} of this activity to ignore for heart rate in intervals.icu. ${kept}: a heart-rate number that covers such a part is not reliable.`,
      );
    }
  }
  if (uses.pace) {
    if (activity.ignore_pace === true || activity.ignore_velocity === true) {
      warnings.push(
        `You marked this activity's pace to ignore in intervals.icu. ${kept}: read each pace number as not reliable.`,
      );
    } else if (paceParts > 0) {
      warnings.push(
        `You marked ${partsText(paceParts)} of this activity to ignore for pace in intervals.icu. ${kept}: a pace number that covers such a part is not reliable.`,
      );
    }
  }
  if (activity.icu_ignore_time === true) {
    warnings.push(
      `You marked this activity's time to ignore in intervals.icu. ${kept}.`,
    );
  }
  return warnings;
}
