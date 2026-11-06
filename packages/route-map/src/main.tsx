import {
  type AppMode,
  AppRoot,
  AppShell,
  ErrorState,
  type HostCtx,
  useServerToolData,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { RouteMap } from "./RouteMap";
import { RouteView } from "./RouteView";
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
  const { data, loading, error, progress, retry } =
    useServerToolData<RouteMapData>(app, "get-route-map-data", {
      ...toolArgs,
    });

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton progress={progress} />
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
  const { data, loading, error, progress, retry } =
    useServerToolData<RouteSuggestionsData>(app, "get-route-suggestions-data", {
      ...args,
    });

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton progress={progress} />
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
  if (!("kind" in toolArgs))
    return <ActivityContent toolArgs={toolArgs} {...rest} />;
  return toolArgs.kind === "route" ? (
    <RouteView args={toolArgs} {...rest} />
  ) : (
    <SuggestionContent args={toolArgs.args} {...rest} />
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
