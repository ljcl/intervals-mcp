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
import { CompareActivities } from "./CompareActivities";
import { type ActivityStreamData, type CompareData } from "./types";
import "./global.css";

interface ToolArgs {
  activity_id_1: string;
  activity_id_2: string;
}

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
}

function AppContent({ app, toolArgs, hostCtx, mode }: AppContentProps) {
  const streamsA = useServerToolData<ActivityStreamData>(
    app,
    "get-activity-streams-raw",
    { activity_id: toolArgs.activity_id_1 },
  );
  const streamsB = useServerToolData<ActivityStreamData>(
    app,
    "get-activity-streams-raw",
    { activity_id: toolArgs.activity_id_2 },
  );
  // The aggregate summary is an enhancement: the overlay renders without it,
  // so a failed compare fetch only drops the delta bar.
  const compare = useServerToolData<CompareData>(
    app,
    "get-compare-activities-data",
    {
      activity_id_1: toolArgs.activity_id_1,
      activity_id_2: toolArgs.activity_id_2,
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
        />
      )}
    </AppShell>
  );
}

function Root() {
  return (
    <AppRoot<ToolArgs>
      appInfo={{ name: "Compare Activities", version: "1.0.0" }}
      parseToolInput={(args) => {
        const next = args as ToolArgs | undefined;
        return next?.activity_id_1 && next?.activity_id_2 ? next : null;
      }}
      missingArgsMessage="Two activity ids are needed to compare activities; the host provided fewer."
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
