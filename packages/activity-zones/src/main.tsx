import {
  type AppMode,
  AppRoot,
  AppShell,
  ErrorState,
  type HostCtx,
  LoadingState,
  Skeleton,
  useServerToolData,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type ActivityZonesData } from "./types";
import "./global.css";

interface ToolArgs {
  activity_id?: string | number;
}

const LoadingSkeleton = () => (
  <LoadingState label="Loading activity zones">
    <Skeleton variant="bar" />
    <Skeleton variant="chart" />
  </LoadingState>
);

interface AppContentProps {
  app: ReturnType<typeof useApp>["app"];
  toolArgs: ToolArgs;
  hostCtx: HostCtx;
  mode: AppMode;
}

function AppContent({ app, toolArgs, hostCtx, mode }: AppContentProps) {
  const { data, loading, error, retry } = useServerToolData<ActivityZonesData>(
    app,
    "get-activity-zones-data",
    { activity_id: toolArgs.activity_id },
  );

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton />
      ) : error || !data ? (
        <ErrorState
          message={error ?? "No zone data available"}
          onRetry={retry}
        />
      ) : (
        <App app={app} data={data} mode={mode} />
      )}
    </AppShell>
  );
}

function Root() {
  return (
    <AppRoot<ToolArgs>
      appInfo={{ name: "Activity Zones", version: "1.0.0" }}
      parseToolInput={(args) => {
        const next = args as ToolArgs | undefined;
        return next?.activity_id != null ? next : null;
      }}
      missingArgsMessage="No activity id was provided to the zones view."
      loading={<LoadingSkeleton />}
    >
      {({ app, toolArgs, hostCtx, mode }) => (
        <AppContent
          app={app}
          toolArgs={toolArgs}
          hostCtx={hostCtx}
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
