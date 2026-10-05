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
import { CompareActivities } from "./CompareActivities";
import { parseToolArgs, type ToolArgs } from "./toolArgs";
import { type ActivityStreamData, type CompareData } from "./types";
import { VIEW_TOOLS } from "./viewToolDeclarations";
import "./global.css";

const LoadingSkeleton = () => (
  <LoadingState label="Loading activity comparison">
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
  const streamsA = useServerToolData<ActivityStreamData>(
    app,
    "get-activity-streams-raw",
    { id: toolArgs.activityId1 },
  );
  const streamsB = useServerToolData<ActivityStreamData>(
    app,
    "get-activity-streams-raw",
    { id: toolArgs.activityId2 },
  );
  // The aggregate summary is an enhancement: the overlay renders without it,
  // so a failed compare fetch only drops the delta bar.
  const compare = useServerToolData<CompareData>(
    app,
    "get-compare-activities-data",
    {
      activityId1: toolArgs.activityId1,
      activityId2: toolArgs.activityId2,
    },
  );

  const loading = streamsA.loading || streamsB.loading || compare.loading;
  const streamError = streamsA.error ?? streamsB.error;
  const retryStreams = () => {
    if (streamsA.error || !streamsA.data) streamsA.retry();
    if (streamsB.error || !streamsB.data) streamsB.retry();
  };

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton />
      ) : streamError || !streamsA.data || !streamsB.data ? (
        <ErrorState
          message={streamError ?? "No activity data available"}
          onRetry={retryStreams}
        />
      ) : (
        <CompareActivities
          a={streamsA.data}
          b={streamsB.data}
          compare={compare.data}
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
      appInfo={{ name: "Compare Activities", version: "1.0.0" }}
      parseToolInput={parseToolArgs}
      missingArgsMessage="Two activity ids are needed to compare activities; the host provided fewer."
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
