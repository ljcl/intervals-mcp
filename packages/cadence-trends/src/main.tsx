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
import { App } from "./App";
import { parseToolArgs, type ToolArgs } from "./toolArgs";
import { type CadenceTrendData } from "./types";
import { VIEW_TOOLS } from "./viewToolDeclarations";
import "./global.css";

const LoadingSkeleton = ({ progress }: { progress?: string | null }) => (
  <LoadingState label="Loading cadence trends" progress={progress}>
    <Skeleton variant="bar" />
    <Skeleton variant="pills" />
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
  const { data, loading, error, progress, retry } =
    useServerToolData<CadenceTrendData>(app, "get-cadence-trend-data", {
      days: toolArgs.days,
    });

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton progress={progress} />
      ) : error || !data ? (
        <ErrorState
          message={error ?? "No cadence data available"}
          onRetry={retry}
        />
      ) : (
        <App
          app={app}
          data={data}
          mode={mode}
          viewToolRegistry={viewToolRegistry}
        />
      )}
    </AppShell>
  );
}

function Root() {
  return (
    <AppRoot<ToolArgs>
      appInfo={{ name: "Cadence Trends", version: "1.0.0" }}
      // Every argument is optional, so no input can be unusable and no
      // `missingArgsMessage` applies — the window falls back to a default.
      parseToolInput={parseToolArgs}
      viewTools={VIEW_TOOLS}
      loading={<LoadingSkeleton />}
    >
      {({ app, toolArgs, hostCtx, mode, viewToolRegistry }) => (
        <AppContent
          app={app}
          toolArgs={toolArgs}
          hostCtx={hostCtx}
          mode={mode}
          viewToolRegistry={viewToolRegistry}
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
