import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";

/**
 * Tools this view exposes to the host and model. Declared at module
 * scope because they are registered before `connect()`; `ActivityChart`
 * installs the implementation once it owns the brush window.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-brush-window",
    title: "Zoom the chart",
    description:
      "Zoom the activity chart's x-axis to one window of the activity, given either in kilometres from the start or in seconds of elapsed time. Use it to put the part of the run being discussed on screen — a surge, a climb, an interval — rather than describing where to look. Pass reset to show the whole activity again.",
    inputSchema: z
      .object({
        fromKm: z
          .number()
          .min(0)
          .nullish()
          .describe(
            "Start of the window, in km from the start. Use with toKm for a distance window.",
          ),
        toKm: z
          .number()
          .min(0)
          .nullish()
          .describe("End of the window, in km from the start."),
        fromSeconds: z
          .number()
          .min(0)
          .nullish()
          .describe(
            "Start of the window, in seconds of elapsed time. Use with toSeconds for a time window.",
          ),
        toSeconds: z
          .number()
          .min(0)
          .nullish()
          .describe("End of the window, in seconds of elapsed time."),
        reset: z
          .boolean()
          .nullish()
          .describe("Zoom back out to the whole activity."),
      })
      .strict(),
  },
];
