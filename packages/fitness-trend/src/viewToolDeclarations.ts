import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";

const series = z.enum(["fitness", "fatigue", "form", "plan"]);

/**
 * Tools this view exposes to the host and model. Declared at module scope
 * because they are registered before `connect()`; `App` installs the
 * implementation once it is mounted and owns the scope and the series toggles.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-scope",
    title: "Change the fitness view",
    description:
      "Switch the fitness chart between whole-body load and runs only, and show or hide the fitness, fatigue, form and plan series.",
    inputSchema: z
      .object({
        scope: z
          .enum(["wholeBody", "runOnly"])
          .nullish()
          .describe("Load scope."),
        show: z.array(series).nullish().describe("Series to show."),
        hide: z.array(series).nullish().describe("Series to hide."),
      })
      .strict(),
  },
];
