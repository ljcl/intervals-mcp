/**
 * MCP prompts: slash-invokable guided workflows built from this server's
 * own tools. Discovery goes through this server's own `list-activities`
 * (intervals.icu-backed, ported in Phase 2), not the official Strava
 * connector.
 *
 * Prompts are data; the ListPrompts/GetPrompt handlers in server.ts serve
 * from this table.
 */

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

export interface PromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

interface PromptDefinition {
  name: string;
  /** Display name for hosts that show one in the prompt picker. */
  title: string;
  description: string;
  arguments: PromptArgumentDefinition[];
  /** Builds the user-message text from the (string) arguments. */
  build: (args: Record<string, string>) => string;
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
        description: "How many weeks to review (default: 4)",
        required: false,
      },
    ],
    build: (args) => {
      const weeks = args.weeks || "4";
      return [
        `Give me a training review of my last ${weeks} weeks.`,
        "",
        "Work through it in this order:",
        `1. Call get-training-load with days=${Number(weeks) * 7 || 28} for volume, trend, and any overtraining warnings.`,
        "2. Call list-activities to identify the standout sessions (longest run, hardest effort).",
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
        name: "activity_id",
        description: "Activity to annotate (default: find the most recent run)",
        required: false,
      },
    ],
    build: (args) => {
      const target = args.activity_id
        ? `Use activity ${args.activity_id}.`
        : "Find my most recent run via list-activities.";
      return [
        "Annotate my latest run with a short coaching note.",
        "",
        target,
        "",
        "Steps:",
        "1. Call get-running-summary for the activity (pace, HR zones, cadence, laps).",
        "2. Call get-activity-laps if the lap structure looks interesting (intervals, negative split).",
        "3. Draft a 2-3 sentence coaching note: what the session shows, one thing to keep, one thing to adjust.",
        "4. Show me the draft and ask before writing anything.",
        '5. On my confirmation, call update-activity with descriptionMode: "append" to add it below the existing description, not overwrite it.',
      ].join("\n");
    },
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
 * GetPrompt payload. An unknown name or a missing required argument throws
 * Invalid Params (-32602), the code `resources/read` uses for an unknown
 * uri. A plain `Error` reaches the client as a generic Internal Error
 * (-32603), which reads as a server fault.
 *
 * `prompts` defaults to the table above. Tests pass their own, because no
 * shipped prompt has a required argument yet.
 */
export function getPrompt(
  name: string,
  args: Record<string, string> = {},
  prompts: readonly PromptDefinition[] = PROMPTS,
): {
  description: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
  const prompt = prompts.find((p) => p.name === name);
  if (!prompt) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown prompt: ${name}`,
    );
  }
  for (const arg of prompt.arguments) {
    if (arg.required && !args[arg.name]) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Missing required argument "${arg.name}" for prompt ${name}`,
      );
    }
  }
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text: prompt.build(args) },
      },
    ],
  };
}
