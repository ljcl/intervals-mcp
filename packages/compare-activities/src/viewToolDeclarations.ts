import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";

/**
 * Tools this view exposes to the host and model. Declared at module scope
 * because they are registered before `connect()`; `CompareActivities`
 * installs the implementation once it is mounted and owns the metric and the
 * axis.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-metric",
    title: "Change the compared metric",
    description:
      "Choose which metric the comparison overlays and whether its x-axis is distance or time. Only metrics both activities recorded are available.",
    inputSchema: z
      .object({
        metric: z
          .enum(["pace", "heartrate", "power", "cadence", "altitude"])
          .nullish()
          .describe("Metric to overlay."),
        axis: z
          .enum(["distance", "time"])
          .nullish()
          .describe("Overlay x-axis."),
      })
      .strict(),
  },
];
