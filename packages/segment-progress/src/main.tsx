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
import { type SegmentProgressData, type ToolArgs } from "./types";
import "./global.css";

const LoadingSkeleton = () => (
  <LoadingState label="Loading segment history">
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
  const { data, loading, error, retry } =
    useServerToolData<SegmentProgressData>(app, "get-segment-progress-data", {
      segment_id: toolArgs.segment_id,
      ...(toolArgs.start_date_local
        ? { start_date_local: toolArgs.start_date_local }
        : {}),
      ...(toolArgs.end_date_local
        ? { end_date_local: toolArgs.end_date_local }
        : {}),
    });

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton />
      ) : error || !data ? (
        <ErrorState
          message={error ?? "No segment history available"}
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
      appInfo={{ name: "Segment Progress", version: "1.0.0" }}
      parseToolInput={(args) => {
        const next = args as ToolArgs | undefined;
        return next?.segment_id ? next : null;
      }}
      missingArgsMessage="No segment id was provided to the segment progress view."
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
