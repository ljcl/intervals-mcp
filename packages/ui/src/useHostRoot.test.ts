/**
 * Host-context handling in `useHostRoot` (#54).
 *
 * In ext-apps 2.0.0 a host-context notification carries only the fields that
 * changed. The shell must keep the fields it did not name: losing
 * `availableDisplayModes` hides the fullscreen toggle, and losing
 * `platform` or `safeAreaInsets` breaks mobile layout.
 */
import {
  type App,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useHostRoot } from "./AppShell";
import { renderHook } from "./renderHook";

/** The app the fake `useApp` hands over. Each test installs its own. */
const connection = vi.hoisted(() => ({ app: null as unknown }));

// The real `useApp` opens a postMessage channel to a host. This fake keeps
// its order: `onAppCreated` runs first, and the app arrives on a later
// render, once "connected".
vi.mock("@modelcontextprotocol/ext-apps/react", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useApp: ({ onAppCreated }: { onAppCreated?: (app: unknown) => void }) => {
      const [app, setApp] = useState<unknown>(null);
      // Like the real hook, connect once per mount.
      useEffect(() => {
        onAppCreated?.(connection.app);
        setApp(connection.app);
      }, []);
      return { app, isConnected: app !== null, error: null };
    },
    useHostStyles: () => undefined,
  };
});

type HostContextListener = (changed: McpUiHostContext) => void;

/**
 * App stand-in with the SDK's host-context semantics: the SDK merges a
 * notification into `getHostContext()` first, then calls the deprecated
 * `onhostcontextchanged` setter, then each listener.
 */
function fakeApp(initial: McpUiHostContext) {
  let context = initial;
  let listeners: HostContextListener[] = [];
  const app = {
    onhostcontextchanged: undefined as HostContextListener | undefined,
    getHostContext: () => context,
    addEventListener: (event: string, listener: HostContextListener) => {
      if (event === "hostcontextchanged") listeners.push(listener);
    },
    removeEventListener: (event: string, listener: HostContextListener) => {
      if (event === "hostcontextchanged") {
        listeners = listeners.filter((l) => l !== listener);
      }
    },
  };
  return {
    app: app as unknown as App,
    listenerCount: () => listeners.length,
    /** Send only the changed fields, as a host does. */
    changeHostContext: async (changed: McpUiHostContext) => {
      await act(async () => {
        context = { ...context, ...changed };
        app.onhostcontextchanged?.(changed);
        for (const listener of [...listeners]) listener(changed);
      });
    },
  };
}

/** Full context from a phone host, as the initialize result sends it. */
const PHONE: McpUiHostContext = {
  platform: "mobile",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  deviceCapabilities: { touch: true, hover: false },
  containerDimensions: { width: 390, maxHeight: 700 },
  safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 },
  displayMode: "inline",
  availableDisplayModes: ["inline", "fullscreen"],
};

const OPTIONS = {
  appInfo: { name: "test-app", version: "1.0.0" },
  parseToolInput: () => null,
};

async function connect(initial: McpUiHostContext) {
  const host = fakeApp(initial);
  connection.app = host.app;
  const harness = await renderHook(() => useHostRoot(OPTIONS), undefined);
  return { host, harness };
}

describe("useHostRoot host context", () => {
  it("keeps the other fields when the host sends only the display mode", async () => {
    const { host, harness } = await connect(PHONE);
    expect(harness.current().hostCtx).toEqual(PHONE);

    // What a host sends after it enters fullscreen.
    await host.changeHostContext({ displayMode: "fullscreen" });

    const root = harness.current();
    expect(root.hostCtx).toEqual({ ...PHONE, displayMode: "fullscreen" });
    // AppShell's fullscreen gate: the exit control must stay on screen.
    expect(root.app).not.toBeNull();
    expect(root.hostCtx.availableDisplayModes).toContain("fullscreen");
    expect(root.mode).toBe("mobile");

    await harness.unmount();
  });

  it("keeps the other fields when the host sends only new dimensions", async () => {
    const { host, harness } = await connect(PHONE);

    // What a host sends when the phone rotates.
    const rotated = { width: 844, maxHeight: 390 };
    await host.changeHostContext({ containerDimensions: rotated });

    const root = harness.current();
    expect(root.hostCtx).toEqual({ ...PHONE, containerDimensions: rotated });
    // Wider than the breakpoint now, but the other signals still say phone.
    expect(root.mode).toBe("mobile");

    await harness.unmount();
  });

  it("listens while mounted and stops on unmount", async () => {
    const { host, harness } = await connect(PHONE);
    expect(host.listenerCount()).toBe(1);

    await harness.unmount();

    expect(host.listenerCount()).toBe(0);
  });
});
