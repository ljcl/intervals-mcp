import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";

/**
 * Tools this view exposes to the host and model. Declared at module
 * scope because they are registered before `connect()`; `RouteMap` installs
 * the implementation once it is mounted and owns a viewBox.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-viewport",
    title: "Frame part of the route",
    description:
      "Zoom the route map to a stretch of the course, given in kilometres from the start. Use it to show the user where on the route something happens — a climb, a split, a segment — instead of only describing it. Omit both bounds and pass reset to show the whole route again.",
    inputSchema: z
      .object({
        fromKm: z
          .number()
          .min(0)
          .nullish()
          .describe(
            "Start of the stretch, in km from the start. Defaults to the start of the route.",
          ),
        toKm: z
          .number()
          .min(0)
          .nullish()
          .describe(
            "End of the stretch, in km from the start. Defaults to the end of the route.",
          ),
        reset: z
          .boolean()
          .nullish()
          .describe("Zoom back out to the whole route."),
      })
      .strict(),
  },
];
