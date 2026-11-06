// @vitest-environment happy-dom
/**
 * A stored route's edit flow, end to end through `RouteView`: the first
 * version loads, an edit goes to amend-route from the shown version, and
 * the result decides what happens next. A new version loads (with the
 * waypoints moved from the version their km were read on) and the model
 * context names it; a refusal or a stored-nothing result is shown and the
 * version stays; a client that may not run writes sends the change to the
 * chat. The app is a fake; the map draws on the offline grid.
 */
import { type App } from "@modelcontextprotocol/ext-apps";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedRouteMap } from "./__fixtures__/storedRoute";
import { RouteView } from "./RouteView";
import { type RouteArgs, type RouteMapData } from "./types";

// MapLibre does not load in happy-dom; the map draws on the grid anyway.
vi.mock("./BasemapView", () => ({ BasemapView: () => null }));

interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const LEGACY_REFUSAL =
  "❌ amend-route changes data, and this client connects with a 2025 protocol revision, so the server does not run it. To make the change, use a client that speaks the 2026-07-28 revision.";

function version(n: number): RouteMapData {
  return {
    ...storedRouteMap,
    name: `Rozelle, Bay Run and Pyrmont (v${n})`,
    route: {
      ...storedRouteMap.route!,
      version: n,
      latest_version: n,
      versions: [
        ...storedRouteMap.route!.versions,
        { version: n, change: "Removed v2" },
      ],
    },
  };
}

function applied(n: number): ToolResult {
  return {
    content: [{ type: "text", text: `Route r7k2m9qx4a is now version ${n}.` }],
    structuredContent: {
      route_id: "r7k2m9qx4a",
      version: n,
      latest_version: n,
      applied: true,
      change: {
        from_version: n - 1,
        to_version: n,
        distance_change_m: -420,
        changed: true,
        from_km: 5.1,
        to_km: 6.3,
        old_from_km: 5.1,
        old_to_km: 6.7,
      },
      warnings: [],
    },
  };
}

interface FakeHost {
  calls: ToolCall[];
  messages: string[];
  updates: string[];
  app: App;
}

function fakeHost(
  amend: () => Promise<ToolResult>,
  capabilities: Record<string, unknown> = {
    updateModelContext: {},
    message: {},
  },
): FakeHost {
  const calls: ToolCall[] = [];
  const messages: string[] = [];
  const updates: string[] = [];
  const app = {
    getHostCapabilities: () => capabilities,
    updateModelContext: async ({
      content,
    }: {
      content: Array<{ text: string }>;
    }) => {
      updates.push(content[0]!.text);
      return {};
    },
    sendMessage: async ({ content }: { content: Array<{ text: string }> }) => {
      messages.push(content[0]!.text);
      return {};
    },
    callServerTool: async (call: ToolCall): Promise<ToolResult> => {
      calls.push(call);
      if (call.name === "amend-route") return amend();
      const v = (call.arguments?.version as number | undefined) ?? 3;
      return { content: [{ type: "text", text: JSON.stringify(version(v)) }] };
    },
  };
  return { calls, messages, updates, app: app as unknown as App };
}

const ARGS: RouteArgs = {
  kind: "route",
  route_id: "r7k2m9qx4a",
  waypoints: [{ km: 6, label: "Water", kind: "water" }],
};

let container: HTMLDivElement;
let root: Root;

async function mount(host: FakeHost, args: RouteArgs = ARGS) {
  await act(async () => {
    root.render(
      <RouteView
        app={host.app}
        args={args}
        hostCtx={{}}
        mode="desktop"
        viewToolRegistry={null}
        basemapEnabled={false}
      />,
    );
  });
}

/** Lets pending promises (the fake host's replies) settle inside act. */
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );

async function click(el: Element | undefined) {
  expect(el).toBeDefined();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Select via point v2, then press Remove. */
async function removeV2() {
  await click(viaPill("v2"));
  await click(button("Remove v2"));
  await settle();
}

function viaPill(id: string) {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(`${id} ·`),
  );
}

const noticeText = () =>
  [...container.querySelectorAll("p[data-tone]")].map((p) => p.textContent);

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("RouteView", () => {
  it("loads the route the host asked for", async () => {
    const host = fakeHost(async () => applied(4));
    await mount(host, { ...ARGS, version: 3, compare_to_version: 2 });
    await settle();

    expect(host.calls[0]).toEqual({
      name: "get-route-map-data",
      arguments: {
        route_id: "r7k2m9qx4a",
        version: 3,
        compare_to_version: 2,
        waypoints: ARGS.waypoints,
      },
    });
    expect(container.textContent).toContain("Version 3 of 3");
    expect(container.textContent).toContain("Change this route");
  });

  it("loads the new version after an edit and tells the model", async () => {
    const host = fakeHost(async () => applied(4));
    await mount(host);
    await settle();
    await removeV2();

    const amend = host.calls.find((c) => c.name === "amend-route");
    expect(amend?.arguments).toEqual({
      route_id: "r7k2m9qx4a",
      base_version: 3,
      operations: [{ op: "remove_via", via_id: "v2" }],
    });

    await settle();
    const reload = host.calls.at(-1);
    expect(reload).toEqual({
      name: "get-route-map-data",
      arguments: {
        route_id: "r7k2m9qx4a",
        version: 4,
        compare_to_version: 3,
        waypoints: ARGS.waypoints,
        // The km were read on the version that first loaded.
        waypoints_version: 3,
      },
    });
    expect(container.textContent).toContain("Version 4 of 4");
    expect(noticeText().join(" ")).toContain(
      "Route r7k2m9qx4a is now version 4 (5.1–6.3 km changed, −420 m).",
    );

    // The context sync is debounced (600 ms).
    await settle(700);
    expect(host.updates.at(-1)).toMatch(
      /^Route r7k2m9qx4a is now version 4 \(5\.1–6\.3 km changed, −420 m\)\. Viewing the map for stored route/,
    );
  });

  it("shows the server's error and stays on the version", async () => {
    const host = fakeHost(async () => ({
      isError: true,
      content: [{ type: "text", text: "❌ No via point v2 on version 3." }],
    }));
    await mount(host);
    await settle();
    await removeV2();

    expect(noticeText()).toContain("❌ No via point v2 on version 3.");
    expect(container.textContent).toContain("Version 3 of 3");
    expect(
      host.calls.filter((c) => c.name === "get-route-map-data"),
    ).toHaveLength(1);
    expect(host.messages).toEqual([]);
  });

  it("shows why nothing was stored when applied is false", async () => {
    const host = fakeHost(async () => ({
      content: [{ type: "text", text: "No change was made." }],
      structuredContent: {
        route_id: "r7k2m9qx4a",
        version: 3,
        latest_version: 3,
        applied: false,
        change: null,
        warnings: ["No change was made: out of routing budget."],
      },
    }));
    await mount(host);
    await settle();
    await removeV2();

    expect(noticeText()).toContain(
      "No change was made: out of routing budget.",
    );
    expect(container.textContent).toContain("Version 3 of 3");
    expect(
      host.calls.filter((c) => c.name === "get-route-map-data"),
    ).toHaveLength(1);
  });

  it("asks the chat to make the change when the client may not write", async () => {
    const host = fakeHost(async () => ({
      isError: true,
      content: [{ type: "text", text: LEGACY_REFUSAL }],
    }));
    await mount(host);
    await settle();
    await removeV2();

    expect(host.messages).toEqual([
      'Please apply this change with amend-route: {"route_id":"r7k2m9qx4a","base_version":3,"operations":[{"op":"remove_via","via_id":"v2"}]}',
    ]);
    const text = noticeText().join(" ");
    expect(text).toContain("which will apply it");
    expect(text).not.toContain("is now version");
    expect(container.textContent).toContain("Version 3 of 3");
  });

  it("asks the chat when the call itself fails", async () => {
    const host = fakeHost(async () => {
      throw new Error("Request timed out");
    });
    await mount(host);
    await settle();
    await removeV2();

    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]).toMatch(/^Please apply this change/);
  });

  it("says what to ask when the host takes no messages", async () => {
    const host = fakeHost(
      async () => ({
        isError: true,
        content: [{ type: "text", text: LEGACY_REFUSAL }],
      }),
      {},
    );
    await mount(host);
    await settle();
    await removeV2();

    expect(host.messages).toEqual([]);
    expect(noticeText().join(" ")).toContain(
      "Ask in the chat: Remove point v2.",
    );
  });

  it("shows no edit controls on an older version", async () => {
    const host = fakeHost(async () => applied(4));
    const older = {
      ...version(2),
      route: { ...version(2).route!, latest_version: 3, editable: false },
    };
    host.app.callServerTool = (async () => ({
      content: [{ type: "text", text: JSON.stringify(older) }],
    })) as unknown as App["callServerTool"];
    await mount(host, { ...ARGS, version: 2 });
    await settle();

    expect(container.textContent).toContain("Version 2 of 3");
    expect(container.textContent).not.toContain("Change this route");
    expect(viaPill("v2")).toBeUndefined();
  });
});
