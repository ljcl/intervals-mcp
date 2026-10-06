import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";

const series = z.enum(["trend", "load", "warnings"]);

/**
 * Tools this view exposes to the host and model. Declared at module scope
 * because they are registered before `connect()`; `App` installs the
 * implementation once it is mounted and owns the scope and the series toggles.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-scope",
    title: "Change the training load view",
    description:
      "Switch the training load card between whole-body load and runs only, and show or hide the trend line, the load line and the volume-spike warning highlights.",
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
