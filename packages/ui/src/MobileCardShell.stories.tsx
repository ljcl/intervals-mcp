import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { CardHeader } from "./CardHeader";
import { EmptyState } from "./EmptyState";
import { MobileCardShell } from "./MobileCardShell";

const meta = preview.meta({
  component: MobileCardShell,
});

const content = (
  <>
    <CardHeader title="Morning Run" subtitle="Run · 10.2 km" compact />
    <EmptyState>Story content renders here</EmptyState>
  </>
);

/**
 * The decorator shell itself, at the claudeIosCard viewport it is meant
 * for: the 3px outer margin must keep the card border visible at the
 * iframe edge, and the width clamp must prevent horizontal scroll.
 */
export const Default = meta.story({
  render: () => <MobileCardShell>{content}</MobileCardShell>,
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
});

export const Dark = meta.story({
  render: () => <MobileCardShell>{content}</MobileCardShell>,
  globals: {
    ...darkGlobals,
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
});
