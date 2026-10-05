/**
 * MCP prompts: slash-invokable guided workflows built from this server's
 * own tools. Each one names the tool chain for a common runner question, so
 * the model does not plan it from scratch.
 *
 * Prompts are data; the ListPrompts/GetPrompt/Complete handlers in server.ts
 * serve from this table. Prompts are not in `tool-surface.lock.json`, so
 * changing one re-prompts nobody. New argument names follow the naming
 * scheme in docs/architecture.md (camelCase, `id` for one activity).
 */

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { matchEnum } from "./argAliases";
import { getTimeZone } from "./config";
import { MAX_TAPER_DAYS, taperTargetDateError } from "./fitnessTrend";
import { RACE_DISTANCES } from "./racePrediction";
import { addDays, daysBetween, todayLocal } from "./utils/localDate";

export interface PromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

interface PromptContext {
  /** Today in the configured time zone (YYYY-MM-DD). */
  today: string;
}

interface PromptDefinition {
  name: string;
  /** Display name for hosts that show one in the prompt picker. */
  title: string;
  description: string;
  arguments: PromptArgumentDefinition[];
  /** Static `completion/complete` suggestions, keyed by argument name. */
  completions?: Record<string, readonly string[]>;
  /**
   * Builds the user-message text from the (string) arguments. Throws
   * {@link invalidParams} on an argument it cannot use.
   */
  build: (args: Record<string, string>, ctx: PromptContext) => string;
}

/** Invalid Params (-32602): the caller's argument was wrong, not the server. */
function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

/** The step that finds the activity: the given id, else the newest run. */
function targetStep(id: string | undefined): string {
  return id ? `Use activity ${id}.` : 'Use id "latest" (my most recent run).';
}

const MAX_REVIEW_WEEKS = 52;

function reviewWeeks(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 4;
  const weeks = Number(raw);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_REVIEW_WEEKS) {
    throw invalidParams(
      `weeks must be a whole number from 1 to ${MAX_REVIEW_WEEKS}; got "${raw}".`,
    );
  }
  return weeks;
}

const RACE_DISTANCE_NAMES = Object.keys(RACE_DISTANCES);

function raceDistance(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  const matched = matchEnum(raw, RACE_DISTANCE_NAMES);
  if (typeof matched === "string" && RACE_DISTANCE_NAMES.includes(matched))
    return matched;
  throw invalidParams(
    `distance "${raw}" is not one of: ${RACE_DISTANCE_NAMES.join(", ")}.`,
  );
}

/** get-fitness-trend's own targetTsb bounds and default. */
function targetTsb(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 10;
  const tsb = Number(raw);
  if (!Number.isFinite(tsb) || tsb < -40 || tsb > 40) {
    throw invalidParams(
      `targetTsb must be a number from -40 to 40; got "${raw}".`,
    );
  }
  return tsb;
}

const PROMPTS: PromptDefinition[] = [
  {
    name: "weekly-review",
    title: "Weekly training review",
    description:
      "Review recent training: load trend, key workouts, and cadence patterns, ending with focus points for next week.",
    arguments: [
      {
        name: "weeks",
        description: `How many weeks to review, 1 to ${MAX_REVIEW_WEEKS} (default: 4)`,
        required: false,
      },
    ],
    completions: { weeks: ["4", "6", "8", "12", "26", "52"] },
    build: (args, { today }) => {
      const weeks = reviewWeeks(args.weeks);
      const days = weeks * 7;
      const oldest = addDays(today, -(days - 1));
      return [
        `Give me a training review of my last ${weeks} weeks (${oldest} to ${today}).`,
        "",
        "Work through it in this order:",
        `1. Call get-training-load with days=${days} for volume, trend, and any overtraining warnings.`,
        `2. Call list-activities with oldest=${oldest}, newest=${today} and limit=200 to identify the standout sessions (longest run, hardest effort).`,
        "3. For the 1-2 standout runs, call get-running-summary (and compare-activities if two are directly comparable).",
        `4. Render view-cadence-trends with weeks=${weeks} so I can explore cadence patterns interactively.`,
        "",
        "Finish with: what went well, what to watch, and 2-3 concrete focus points for next week. Keep it grounded in the numbers you fetched.",
      ].join("\n");
    },
  },
  {
    name: "annotate-last-run",
    title: "Annotate my last run",
    description:
      "Analyse the most recent run and append a short coaching note to its activity description (confirms before writing).",
    arguments: [
      {
        name: "id",
        description: "Activity to annotate (default: find the most recent run)",
        required: false,
      },
    ],
    build: (args) =>
      [
        "Annotate my latest run with a short coaching note.",
        "",
        // `activity_id` was this argument's name before the naming scheme.
        targetStep(args.id || args.activity_id),
        "",
        "Steps:",
        "1. Call get-running-summary for the activity (pace, HR zones, cadence, laps).",
        "2. Draft a 2-3 sentence coaching note: what the session shows, one thing to keep, one thing to adjust.",
        "3. Show me the draft and ask before writing anything.",
        '4. On my confirmation, call update-activity with descriptionMode: "append" to add it below the existing description, not overwrite it, using the activity id from get-running-summary (update-activity does not accept "latest").',
      ].join("\n"),
  },
  {
    name: "race-readiness",
    title: "Race readiness",
    description:
      "Check readiness for an upcoming race: form on race day and the taper that gets there, predicted time, recent recovery and load.",
    arguments: [
      {
        name: "raceDate",
        description: `Race date, YYYY-MM-DD, after today and at most ${MAX_TAPER_DAYS} days ahead`,
        required: true,
      },
      {
        name: "distance",
        description: `Race distance: ${RACE_DISTANCE_NAMES.join(", ")}`,
        required: false,
      },
      {
        name: "targetTsb",
        description:
          "Form (TSB) to arrive at on race day (default 10; 5 to 15 is the usual race window)",
        required: false,
      },
    ],
    completions: {
      distance: RACE_DISTANCE_NAMES,
      targetTsb: ["5", "10", "15"],
    },
    build: (args, { today }) => {
      const raceDate = args.raceDate ?? "";
      const dateError = taperTargetDateError(raceDate, today);
      if (dateError)
        throw invalidParams(dateError.replace("targetDate", "raceDate"));
      const distance = raceDistance(args.distance);
      const tsb = targetTsb(args.targetTsb);
      const daysOut = daysBetween(today, raceDate);
      const race = distance ? `${raceDate} (${distance})` : raceDate;
      return [
        `Am I ready for my race on ${race}, ${daysOut} days away? Today is ${today}.`,
        "",
        "Work through it in this order:",
        `1. Call get-fitness-trend with targetDate=${raceDate} and targetTsb=${tsb}: current form, the taper plan that lands on it, and whether rest alone can reach it.`,
        distance
          ? `2. Call get-race-prediction with raceDistance="${distance}" for the predicted time and km splits.`
          : "2. Call get-race-prediction with no raceDistance, for predicted times across distances.",
        `3. Call get-wellness with oldest=${addDays(today, -6)}, newest=${today} for sleep, HRV, resting HR and soreness over the last 7 days.`,
        "4. Call get-training-load with days=28 for recent volume and any injury-risk warnings.",
        "",
        "Finish with a verdict (ready, nearly, or not yet) and the numbers behind it, then the 2-3 things to do between now and race day. The taper plan gives load, not sessions; label any session suggestions as yours.",
      ].join("\n");
    },
  },
  {
    name: "run-debrief",
    title: "Run debrief",
    description:
      "Debrief one run: the summary, the one analysis that fits the session, and how recovered you were going into it.",
    arguments: [
      {
        name: "id",
        description: "Activity to debrief (default: find the most recent run)",
        required: false,
      },
    ],
    build: (args) =>
      [
        "Debrief my run.",
        "",
        targetStep(args.id),
        "",
        "Steps:",
        "1. Call get-running-summary for the activity: pace, HR zones, cadence, laps and running dynamics.",
        "2. Pick the one analysis that fits the run, and call only that one:",
        "   - structured reps in the laps or description: get-interval-analysis",
        "   - a steady run on a mostly flat course: get-split-analysis",
        "   - a lot of climbing for the distance: get-hill-analysis",
        "   - a long easy run: get-aerobic-analysis, for decoupling",
        "3. Call get-wellness with date set to the run's date, for how I came into it (sleep, HRV, resting HR, soreness).",
        "",
        "Finish with: what the run shows, how it compares with what the session was meant to be, and one thing to carry into the next run. Keep it grounded in the numbers you fetched.",
      ].join("\n"),
  },
  {
    name: "injury-check",
    title: "Injury risk check",
    description:
      "Check for signs of overdoing it: load spikes, recovery trend, form flags and shoe mileage, ending with what to change this week.",
    arguments: [],
    build: (_args, { today }) =>
      [
        "Am I overdoing it? Check my injury risk from the data.",
        "",
        "Work through it in this order:",
        "1. Call get-training-load with days=56 for week-over-week load changes and its injury-risk warnings.",
        `2. Call get-wellness with oldest=${addDays(today, -27)}, newest=${today} for the HRV and resting-HR trend, soreness, fatigue and sleep.`,
        "3. Call get-fitness-trend with days=42 for form (TSB) and its flags.",
        "4. Call list-gear for shoe mileage, and flag any pair in use past about 600 to 800 km.",
        "",
        "Finish with a risk read (low, moderate or high) and the specific numbers behind it, then what to change this week. This is training-load guidance, not a diagnosis: if I mention pain, tell me to get it checked.",
      ].join("\n"),
  },
];

/** ListPrompts payload: name, title, description and arguments of each. */
export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({
    name,
    title,
    description,
    arguments: args,
  }));
}

/**
 * GetPrompt payload. An unknown name, a missing required argument, or an
 * argument the prompt cannot use throws Invalid Params (-32602), the code
 * `resources/read` uses for an unknown uri. A plain `Error` reaches the
 * client as a generic Internal Error (-32603), which reads as a server
 * fault. `prompts` and `today` are injectable for tests.
 */
export function getPrompt(
  name: string,
  args: Record<string, string> = {},
  prompts: readonly PromptDefinition[] = PROMPTS,
  today: string = todayLocal(getTimeZone()),
): {
  description: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
  const prompt = prompts.find((p) => p.name === name);
  if (!prompt) throw invalidParams(`Unknown prompt: ${name}`);
  for (const arg of prompt.arguments) {
    if (arg.required && !args[arg.name]) {
      throw invalidParams(
        `Missing required argument "${arg.name}" for prompt ${name}`,
      );
    }
  }
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text: prompt.build(args, { today }) },
      },
    ],
  };
}

/**
 * `completion/complete` values for one prompt argument: its static
 * suggestions that start with what was typed, case-insensitively. Empty for
 * an argument with none. Activity ids get no suggestions: a completion is a
 * bare value with no label, so a list of digit ids helps nobody, and each
 * keystroke would cost an intervals.icu request.
 */
export function completePromptArgument(
  promptName: string,
  argumentName: string,
  value: string,
): string[] {
  const options =
    PROMPTS.find((p) => p.name === promptName)?.completions?.[argumentName] ??
    [];
  const typed = value.toLowerCase();
  return options.filter((option) => option.toLowerCase().startsWith(typed));
}
