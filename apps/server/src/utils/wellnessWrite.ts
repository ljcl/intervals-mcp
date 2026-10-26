import {
  type IntervalsWellness,
  type IntervalsWellnessUpdate,
} from "../intervalsClient";

/**
 * The subjective wellness scores update-wellness writes, keyed by input
 * name, with the intervals.icu field each maps to, the snake_case name
 * get-wellness reports, and the web app's label for 1 to 4. On every scale 1
 * is the best state (docs/api-notes.md, read from the web app's wellness
 * dialog). The athlete's "invert" chart option changes only the charts, not
 * the stored value.
 */
export const WELLNESS_SCORES = {
  soreness: {
    wire: "soreness",
    output: "soreness",
    labels: ["Low", "Average", "High", "Extreme"],
  },
  fatigue: {
    wire: "fatigue",
    output: "fatigue",
    labels: ["Low", "Average", "High", "Extreme"],
  },
  stress: {
    wire: "stress",
    output: "stress",
    labels: ["Low", "Average", "High", "Extreme"],
  },
  mood: {
    wire: "mood",
    output: "mood",
    labels: ["Great", "Good", "OK", "Grumpy"],
  },
  motivation: {
    wire: "motivation",
    output: "motivation",
    labels: ["Extreme", "High", "Average", "Low"],
  },
  injury: {
    wire: "injury",
    output: "injury",
    labels: ["None", "Niggle", "Poor", "Injured"],
  },
  sleepQuality: {
    wire: "sleepQuality",
    output: "sleep_quality",
    labels: ["Great", "Good", "Average", "Poor"],
  },
} as const;

export type WellnessScore = keyof typeof WELLNESS_SCORES;

export const WELLNESS_SCORE_NAMES = Object.keys(
  WELLNESS_SCORES,
) as WellnessScore[];

/** intervals.icu clears a numeric wellness field sent as -1, as the web app
 * does (docs/api-notes.md). */
const CLEAR_SCORE = -1;

/** The web app's label for a 1 to 4 score, or null for any other value. */
export function wellnessScoreLabel(
  score: WellnessScore,
  value: number | null | undefined,
): string | null {
  if (value == null || !Number.isInteger(value)) return null;
  return WELLNESS_SCORES[score].labels[value - 1] ?? null;
}

/** The day's fields update-wellness reads, writes, and echoes. */
export type CurrentWellnessFields = Record<WellnessScore, number | null> & {
  comments: string | null;
};

export function currentWellnessFields(
  day: IntervalsWellness,
): CurrentWellnessFields {
  const fields = { comments: day.comments ?? null } as CurrentWellnessFields;
  for (const score of WELLNESS_SCORE_NAMES) {
    fields[score] = day[WELLNESS_SCORES[score].wire] ?? null;
  }
  return fields;
}

/** What a caller asked to change: a score of `null` clears it; `comments`
 * has already gone through `composeDescription`. */
export type RequestedWellnessFields = Partial<
  Record<WellnessScore, number | null>
> & { comments?: string };

/** `null` and `""` both mean no comments, as with an activity description. */
function normalizeComments(value: string | null | undefined): string {
  return value ?? "";
}

/**
 * Builds the PUT patch, keeping only fields whose requested value differs
 * from `current`, so the write never re-sends an unchanged field. A cleared
 * score is sent as -1, and only when the day has a value to clear.
 */
export function buildWellnessPatch(
  requested: RequestedWellnessFields,
  current: CurrentWellnessFields,
): IntervalsWellnessUpdate {
  const patch: IntervalsWellnessUpdate = {};
  for (const score of WELLNESS_SCORE_NAMES) {
    const value = requested[score];
    if (value === undefined || value === current[score]) continue;
    patch[WELLNESS_SCORES[score].wire] = value === null ? CLEAR_SCORE : value;
  }
  if (
    requested.comments !== undefined &&
    normalizeComments(requested.comments) !==
      normalizeComments(current.comments)
  ) {
    patch.comments = requested.comments;
  }
  return patch;
}

export interface WellnessWriteChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

function formatValue(value: number | null): string {
  return value === null ? "nothing" : String(value);
}

/**
 * Diffs the fresh re-read against the pre-write read for exactly the fields
 * in `patch` (named as get-wellness names them), and warns for any field
 * whose re-read value does not match what was sent.
 */
export function diffWellnessWrite(
  patch: IntervalsWellnessUpdate,
  before: CurrentWellnessFields,
  after: CurrentWellnessFields,
): { changes: WellnessWriteChange[]; warnings: string[] } {
  const changes: WellnessWriteChange[] = [];
  const warnings: string[] = [];

  for (const score of WELLNESS_SCORE_NAMES) {
    const { wire, output } = WELLNESS_SCORES[score];
    const sent = patch[wire];
    if (sent === undefined) continue;
    changes.push({ field: output, before: before[score], after: after[score] });
    const expected = sent === CLEAR_SCORE ? null : sent;
    if (after[score] !== expected) {
      warnings.push(
        `${output} was not applied: sent ${formatValue(expected)}, the day now shows ${formatValue(after[score])}.`,
      );
    }
  }
  if (patch.comments !== undefined) {
    changes.push({
      field: "comments",
      before: before.comments,
      after: after.comments,
    });
    if (
      normalizeComments(after.comments) !== normalizeComments(patch.comments)
    ) {
      warnings.push("comments were not applied as sent.");
    }
  }

  return { changes, warnings };
}
