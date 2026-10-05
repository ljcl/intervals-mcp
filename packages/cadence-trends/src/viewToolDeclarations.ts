import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";
import { MAX_COMPARE_RUNS } from "./types";

/**
 * Tools this view exposes to the host and model. Declared at module scope
 * because they are registered before `connect()`; `App` installs the
 * implementation once it is mounted and owns the view, the selection and the
 * overlay axis.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-view",
    title: "Change the cadence view",
    // The model never sees the chart's runs, so the ids are the ones
    // list-activities gives it.
    description: `Switch the cadence chart between trend, scatter, zones and overlay, choose up to ${MAX_COMPARE_RUNS} runs to overlay, and pick the overlay x-axis. runIds are activity ids from list-activities (for example "i189807578") for runs within the chart's weeks, and replace the current selection.`,
    inputSchema: z
      .object({
        view: z
          .enum(["trend", "scatter", "zones", "overlay"])
          .nullish()
          .describe("Which view to show."),
        runIds: z
          .array(z.string())
          .max(MAX_COMPARE_RUNS)
          .nullish()
          .describe(
            `Activity ids from list-activities to overlay, up to ${MAX_COMPARE_RUNS}; replaces the selection.`,
          ),
        xAxis: z
          .enum(["distance", "time"])
          .nullish()
          .describe("Overlay x-axis."),
      })
      .strict(),
  },
];
