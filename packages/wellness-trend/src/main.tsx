import {
  type AppMode,
  AppRoot,
  AppShell,
  ErrorState,
  type HostCtx,
  LoadingState,
  Skeleton,
  useServerToolData,
  windowToolArgs,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type WellnessToolArgs, type WellnessTrendData } from "./types";
import "./global.css";

const LoadingSkeleton = ({ progress }: { progress?: string | null }) => (
  <LoadingState label="Loading wellness trend" progress={progress}>
    <Skeleton variant="chart" />
  </LoadingState>
);

interface AppContentProps {
  app: ReturnType<typeof useApp>["app"];
  toolArgs: WellnessToolArgs;
  hostCtx: HostCtx;
  mode: AppMode;
}

function AppContent({ app, toolArgs, hostCtx, mode }: AppContentProps) {
  const { data, loading, error, progress, retry } =
    useServerToolData<WellnessTrendData>(
      app,
      "get-wellness-trend-data",
      toolArgs,
    );

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton progress={progress} />
      ) : error || !data ? (
        <ErrorState
          message={error ?? "No wellness data available"}
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
    <AppRoot<WellnessToolArgs>
      appInfo={{ name: "Wellness Trend", version: "1.0.0" }}
      // Both arguments are optional (the range defaults to the last 30
      // days), so no input is unusable and no `missingArgsMessage` applies.
      parseToolInput={(args) =>
        windowToolArgs(args, ["oldest", "newest"]) as WellnessToolArgs
      }
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
