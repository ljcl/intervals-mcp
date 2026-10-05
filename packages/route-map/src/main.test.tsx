// @vitest-environment happy-dom
/**
 * The app end to end through its real `main.tsx`: `useHostRoot` pins an id
 * the host sent as `"latest"` (any spelling) to the run the tool result
 * names, and the app does not fetch its data until then. Only the host
 * connection (`useApp`) and the map itself are faked.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** The fake app `useApp` hands over; each test installs a fresh one. */
const connection = vi.hoisted(() => ({ app: null as unknown }));

vi.mock("@modelcontextprotocol/ext-apps/react", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useApp: ({ onAppCreated }: { onAppCreated?: (app: unknown) => void }) => {
      const [app, setApp] = useState<unknown>(null);
      useEffect(() => {
        onAppCreated?.(connection.app);
        setApp(connection.app);
      }, []);
      return { app, isConnected: app !== null, error: null };
    },
    useHostStyles: () => undefined,
  };
});

// No MapLibre map or SVG projection: the test is about when the data is
// fetched, not what it draws.
vi.mock("./RouteMap", () => ({ RouteMap: () => null }));

function fakeHostApp() {
  const calls: ToolCall[] = [];
  const app = {
    ontoolinput: undefined as
      | ((params: { arguments?: Record<string, unknown> }) => void)
      | undefined,
    ontoolresult: undefined as
      | ((params: Record<string, unknown>) => void)
      | undefined,
    onerror: undefined as unknown,
    getHostContext: () => ({}),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    registerTool: () => undefined,
    callServerTool: async (call: ToolCall) => {
      calls.push(call);
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  return { app, calls };
}

async function mountApp() {
  const host = fakeHostApp();
  connection.app = host.app;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await act(async () => {
    await import("./main");
  });
  return {
    calls: host.calls,
    sendInput: async (args: Record<string, unknown>) => {
      await act(async () => host.app.ontoolinput?.({ arguments: args }));
    },
    sendResult: async (result: Record<string, unknown>) => {
      await act(async () => host.app.ontoolresult?.(result));
    },
  };
}

describe("route-map main", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("waits for the tool result, then fetches the run it pinned", async () => {
    const { calls, sendInput, sendResult } = await mountApp();

    // The model's raw arguments, in the legacy spelling.
    await sendInput({ activity_id: "latest" });
    expect(calls).toEqual([]);

    await sendResult({
      content: [],
      _meta: { "intervals-mcp/resolvedArgs": { id: "i9" } },
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toEqual({
        name: "get-route-map-data",
        arguments: { id: "i9" },
      });
    }
  });

  it("fetches with latest after 1,500 ms when no tool result comes", async () => {
    vi.useFakeTimers();
    const { calls, sendInput } = await mountApp();

    await sendInput({ id: "latest" });
    await act(async () => {
      vi.advanceTimersByTime(1_499);
    });
    expect(calls).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.arguments).toEqual({ id: "latest" });
  });

  it("fetches a concrete id at once, waypoints included", async () => {
    const { calls, sendInput } = await mountApp();
    const waypoints = [{ km: 5, label: "Gel", kind: "fuel" }];

    await sendInput({ id: "i5", waypoints });

    expect(calls[0]).toEqual({
      name: "get-route-map-data",
      arguments: { id: "i5", waypoints },
    });
  });
});
