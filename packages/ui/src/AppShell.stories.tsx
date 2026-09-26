import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { expect } from "storybook/test";
import { AppShell, type DisplayModeApp } from "./AppShell";
import { CardHeader } from "./CardHeader";
import { EmptyState } from "./EmptyState";
import { type HostCtx } from "./useMobileMode";

const meta = preview.meta({
  component: AppShell,
});

const content = (
  <>
    <CardHeader title="Morning Run" subtitle="Run · 10.2 km" />
    <EmptyState>Card content renders here</EmptyState>
  </>
);

export const Desktop = meta.story({
  render: () => (
    <AppShell hostCtx={{}} mode="desktop">
      {content}
    </AppShell>
  ),
});

export const Dark = meta.story({
  globals: darkGlobals,
  render: () => (
    <AppShell hostCtx={{}} mode="desktop">
      {content}
    </AppShell>
  ),
});

export const Mobile = meta.story({
  render: () => (
    <AppShell hostCtx={{}} mode="mobile">
      {content}
    </AppShell>
  ),
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
});

export const MobileWithSafeAreaInsets = meta.story({
  render: () => (
    <AppShell
      hostCtx={{
        safeAreaInsets: { top: 12, right: 10, bottom: 24, left: 10 },
      }}
      mode="mobile"
    >
      {content}
    </AppShell>
  ),
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
});

export const DesktopWithSafeAreaInsets = meta.story({
  render: () => (
    <AppShell
      hostCtx={{
        safeAreaInsets: { top: 12, right: 10, bottom: 24, left: 10 },
      }}
      mode="desktop"
    >
      {content}
    </AppShell>
  ),
});

/** Grants every request, so the toggle's local echo drives the state. */
const grantingApp: DisplayModeApp = {
  requestDisplayMode: ({ mode }) => Promise.resolve({ mode }),
};

/**
 * The fullscreen toggle (#35) renders only when the host advertises
 * fullscreen in availableDisplayModes AND an app is connected; clicking it
 * requests the mode and flips to an exit control on success.
 */
export const FullscreenCapableHost = meta.story({
  render: () => (
    <AppShell
      hostCtx={{ availableDisplayModes: ["inline", "fullscreen"] }}
      mode="desktop"
      app={grantingApp}
    >
      {content}
    </AppShell>
  ),
  play: async ({ canvas, userEvent }) => {
    const enter = canvas.getByRole("button", { name: "Enter fullscreen" });
    await expect(enter).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(enter);

    const exit = await canvas.findByRole("button", { name: "Exit fullscreen" });
    await expect(exit).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(exit);
    await canvas.findByRole("button", { name: "Enter fullscreen" });
  },
});

/** No availableDisplayModes from the host → no dead toggle. */
export const HostWithoutFullscreen = meta.story({
  render: () => (
    <AppShell hostCtx={{}} mode="desktop" app={grantingApp}>
      {content}
    </AppShell>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});

/**
 * A host that reports its display mode once and does not send it again
 * after a request (#54). The toggle shows the mode that each request
 * returned, so it can still enter fullscreen and exit it.
 */
export const HostNeverResendsMode = meta.story({
  render: () => (
    <AppShell
      hostCtx={{
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
      }}
      mode="desktop"
      app={grantingApp}
    >
      {content}
    </AppShell>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Enter fullscreen" }),
    );
    const exit = await canvas.findByRole("button", { name: "Exit fullscreen" });
    await userEvent.click(exit);
    await canvas.findByRole("button", { name: "Enter fullscreen" });
  },
});

/**
 * Stands in for a host that sends its new display mode after every change,
 * also when it leaves fullscreen through its own controls.
 */
function ResendingHost() {
  const [hostCtx, setHostCtx] = useState<HostCtx>({
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
  });
  const setMode = (mode: McpUiDisplayMode) =>
    setHostCtx((ctx) => ({ ...ctx, displayMode: mode }));
  const app: DisplayModeApp = {
    requestDisplayMode: ({ mode }) => {
      setMode(mode);
      return Promise.resolve({ mode });
    },
  };
  return (
    <>
      <AppShell hostCtx={hostCtx} mode="desktop" app={app}>
        {content}
      </AppShell>
      <button type="button" onClick={() => setMode("inline")}>
        Host leaves fullscreen
      </button>
    </>
  );
}

/**
 * The mode the host reports next wins over the toggle's echo of its last
 * request (#54). When the host leaves fullscreen by itself, the toggle
 * offers to enter fullscreen again.
 */
export const HostLeavesFullscreen = meta.story({
  // Interaction-only test: keep it off the autodocs page.
  tags: ["!autodocs"],
  render: () => <ResendingHost />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Enter fullscreen" }),
    );
    await canvas.findByRole("button", { name: "Exit fullscreen" });
    await userEvent.click(
      canvas.getByRole("button", { name: "Host leaves fullscreen" }),
    );
    await canvas.findByRole("button", { name: "Enter fullscreen" });
  },
});
