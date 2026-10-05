import preview from "@intervals-mcp/design-system/preview";
import { type App } from "@modelcontextprotocol/ext-apps";
import { expect } from "storybook/test";
import { AppRootView } from "./AppShell";
import { CardHeader } from "./CardHeader";
import { EmptyState } from "./EmptyState";
import { LoadingState } from "./LoadingState";
import { Skeleton } from "./Skeleton";

/**
 * The four states every MCP App passes through before its content renders.
 * `AppRootView` is the pure half of `AppRoot`, so each branch is reachable
 * here without a live host — these stories are the shared coverage of the
 * convention (ljcl/strava-mcp#249).
 */
const meta = preview.meta({
  component: AppRootView,
});

interface ToolArgs {
  id?: string;
}

/** Stand-in for the connected app; the ready branch only passes it through. */
const connectedApp = {} as App;

const loading = (
  <LoadingState label="Loading activity zones">
    <Skeleton variant="bar" />
    <Skeleton variant="chart" />
  </LoadingState>
);

const content = () => (
  <>
    <CardHeader title="Morning Run" subtitle="Run · 10.2 km" />
    <EmptyState>Content renders once the args arrive</EmptyState>
  </>
);

const base = {
  hostCtx: {},
  mode: "desktop",
  loading,
  children: content,
  // These branches all render before an app is connected, so there is no
  // registry to install view tools into (ljcl/strava-mcp#278).
  viewToolRegistry: null,
  pendingLatest: false,
} as const;

/** Host has not sent tool input yet: skeleton, no error. */
export const WaitingForInput = meta.story({
  render: () => (
    <AppRootView<ToolArgs>
      {...base}
      app={null}
      toolArgs={null}
      connectError={null}
      argsError={null}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toBeInTheDocument();
  },
});

/**
 * Host sent input the app cannot use. Before ljcl/strava-mcp#249 four apps sat on the
 * skeleton forever here; the args error must win over the waiting branch
 * even though `toolArgs` is still null.
 */
export const MissingRequiredArgument = meta.story({
  render: () => (
    <AppRootView<ToolArgs>
      {...base}
      app={connectedApp}
      toolArgs={null}
      connectError={null}
      argsError="No activity id was provided to the zones view."
    />
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("No activity id was provided to the zones view."),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("status")).toBeNull();
  },
});

/** A failed handshake outranks everything else. */
export const ConnectError = meta.story({
  render: () => (
    <AppRootView<ToolArgs>
      {...base}
      app={null}
      toolArgs={null}
      connectError={new Error("host went away")}
      argsError="No activity id was provided to the zones view."
    />
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("Connection error: host went away"),
    ).toBeInTheDocument();
  },
});

/** Connected with usable args: the app's own content takes over. */
export const Ready = meta.story({
  render: () => (
    <AppRootView<ToolArgs>
      {...base}
      app={connectedApp}
      toolArgs={{ id: "123" }}
      connectError={null}
      argsError={null}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Morning Run")).toBeInTheDocument();
    await expect(canvas.queryByRole("status")).toBeNull();
  },
});

/**
 * Opened with `id: "latest"` and the tool result naming the run has not
 * arrived: still the skeleton, so the content does not fetch the word moments
 * before the pin lands.
 */
export const PinningLatest = meta.story({
  render: () => (
    <AppRootView<ToolArgs>
      {...base}
      app={connectedApp}
      toolArgs={{ id: "latest" }}
      pendingLatest
      connectError={null}
      argsError={null}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toBeInTheDocument();
    await expect(canvas.queryByText("Morning Run")).toBeNull();
  },
});
