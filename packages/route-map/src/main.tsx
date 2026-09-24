import {
  type AppMode,
  AppRoot,
  AppShell,
  ErrorState,
  type HostCtx,
  LoadingState,
  optionalObjectSchema,
  Skeleton,
  useServerToolData,
  type ViewToolDefinition,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouteMap } from "./RouteMap";
import { type RouteMapData, type ToolArgs } from "./types";
import "./global.css";

/**
 * Tools this view exposes to the host and model. Declared at module
 * scope because they are registered before `connect()`; `RouteMap` installs
 * the implementation once it is mounted and owns a viewBox.
 */
const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-viewport",
    title: "Frame part of the route",
    description:
      "Zoom the route map to a stretch of the course, given in kilometres from the start. Use it to show the user where on the route something happens — a climb, a split, a segment — instead of only describing it. Omit both bounds and pass reset to show the whole route again.",
    inputSchema: optionalObjectSchema({
      fromKm: {
        type: "number",
        description:
          "Start of the stretch, in km from the start. Defaults to the start of the route.",
        minimum: 0,
      },
      toKm: {
        type: "number",
        description:
          "End of the stretch, in km from the start. Defaults to the end of the route.",
        minimum: 0,
      },
      reset: {
        type: "boolean",
        description: "Zoom back out to the whole route.",
      },
    }),
  },
];

const LoadingSkeleton = () => (
  <LoadingState label="Loading route map">
    <Skeleton variant="bar" />
    <Skeleton variant="chart" />
  </LoadingState>
);

interface AppContentProps {
  app: ReturnType<typeof useApp>["app"];
  toolArgs: ToolArgs;
  hostCtx: HostCtx;
  mode: AppMode;
  viewToolRegistry: ViewToolRegistry | null;
}

function AppContent({
  app,
  toolArgs,
  hostCtx,
  mode,
  viewToolRegistry,
}: AppContentProps) {
  const { data, loading, error, retry } = useServerToolData<RouteMapData>(
    app,
    "get-route-map-data",
    { ...toolArgs },
  );

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton />
      ) : error || !data ? (
        <ErrorState
          message={error ?? "No route map data available"}
          onRetry={retry}
        />
      ) : (
        <RouteMap
          data={data}
          mode={mode}
          app={app ?? undefined}
          viewToolRegistry={viewToolRegistry}
        />
      )}
    </AppShell>
  );
}

function Root() {
  return (
    <AppRoot<ToolArgs>
      appInfo={{ name: "Route Map", version: "1.0.0" }}
      parseToolInput={(args) => {
        const next = args as ToolArgs | undefined;
        return next?.activity_id ? next : null;
      }}
      missingArgsMessage="No activity id was provided to the map view."
      viewTools={VIEW_TOOLS}
      loading={<LoadingSkeleton />}
    >
      {({ app, toolArgs, hostCtx, mode, viewToolRegistry }) => (
        <AppContent
          app={app}
          toolArgs={toolArgs}
          hostCtx={hostCtx}
          viewToolRegistry={viewToolRegistry}
          mode={mode}
        />
      )}
    </AppRoot>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
