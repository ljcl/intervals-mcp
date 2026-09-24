import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { EmptyState } from "./EmptyState";

const meta = preview.meta({
  component: EmptyState,
});

export const Default = meta.story({
  args: { children: "No laps in this activity" },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: { children: "No laps in this activity" },
});
