import { type ViewToolDefinition } from "@intervals-mcp/ui";
import { z } from "zod";
import { ZONE_TYPES } from "./setZoneType";

/**
 * Tools this view exposes to the host and model. Declared at module scope
 * because they are registered before `connect()`; `App` installs the
 * implementation once it is mounted and owns the zone set on screen.
 */
export const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-zone-type",
    title: "Change the zone set shown",
    description:
      "Switch the activity zones card between heart rate and pace zones. Only sets the activity has are available.",
    inputSchema: z
      .object({
        type: z.enum(ZONE_TYPES).nullish().describe("Zone set to show."),
      })
      .strict(),
  },
];
