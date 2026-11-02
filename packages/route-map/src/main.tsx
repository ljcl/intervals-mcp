import {
  type AppMode,
  AppRoot,
  AppShell,
  ErrorState,
  type HostCtx,
  LoadingState,
  Skeleton,
  useServerToolData,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouteMap } from "./RouteMap";
import { SuggestionMap } from "./SuggestionMap";
import { parseToolArgs } from "./toolArgs";
import {
  type AppArgs,
  type RouteMapData,
  type RouteSuggestionsData,
  type ToolArgs,
} from "./types";
import { VIEW_TOOLS } from "./viewToolDeclarations";
import "./global.css";

const LoadingSkeleton = () => (
  <LoadingState label="Loading route map">
    <Skeleton variant="bar" />
    <Skeleton variant="chart" />
  </LoadingState>
);

interface ContentProps {
  app: ReturnType<typeof useApp>["app"];
  hostCtx: HostCtx;
  mode: AppMode;
  viewToolRegistry: ViewToolRegistry | null;
}

function ActivityContent({
  app,
  toolArgs,
  hostCtx,
  mode,
  viewToolRegistry,
}: ContentProps & { toolArgs: ToolArgs }) {
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

function SuggestionContent({
  app,
  args,
  hostCtx,
  mode,
  viewToolRegistry,
}: ContentProps & { args: Record<string, unknown> }) {
  const { data, loading, error, retry } =
    useServerToolData<RouteSuggestionsData>(app, "get-route-suggestions-data", {
      ...args,
    });

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton />
      ) : error || !data ? (
        <ErrorState
          message={error ?? "No route suggestions available"}
          onRetry={retry}
        />
      ) : (
        <SuggestionMap
          data={data}
          mode={mode}
          app={app ?? undefined}
          viewToolRegistry={viewToolRegistry}
        />
      )}
    </AppShell>
  );
}

function AppContent({
  toolArgs,
  ...rest
}: ContentProps & { toolArgs: AppArgs }) {
  return "kind" in toolArgs ? (
    <SuggestionContent args={toolArgs.args} {...rest} />
  ) : (
    <ActivityContent toolArgs={toolArgs} {...rest} />
  );
}

function Root() {
  return (
    <AppRoot<AppArgs>
      appInfo={{ name: "Route Map", version: "1.0.0" }}
      parseToolInput={parseToolArgs}
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
