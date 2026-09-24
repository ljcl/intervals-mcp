import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { CardHeader } from "./CardHeader";

const meta = preview.meta({
  component: CardHeader,
});

export const Default = meta.story({
  args: { title: "Morning Run", subtitle: "Run · 10.2 km · 52:31" },
});

export const TitleOnly = meta.story({
  args: { title: "Morning Run" },
});

export const Compact = meta.story({
  args: {
    title: "Morning Run",
    subtitle: "Run · 10.2 km · 52:31",
    compact: true,
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: { title: "Morning Run", subtitle: "Run · 10.2 km · 52:31" },
});
