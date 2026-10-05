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
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ActivityChart } from "./ActivityChart";
import { extractMeta, toChartData, toLapData } from "./normalize";
import { type ActivityStreamData } from "./types";
import { VIEW_TOOLS } from "./viewToolDeclarations";
import "./global.css";

interface ToolArgs {
  activity_id: string;
}

const LoadingSkeleton = () => (
  <LoadingState label="Loading activity chart">
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
  const {
    data: streamData,
    loading,
    error,
    retry,
  } = useServerToolData<ActivityStreamData>(app, "get-activity-streams-raw", {
    activity_id: toolArgs.activity_id,
  });

  const derived = useMemo(
    () =>
      streamData
        ? {
            meta: extractMeta(streamData),
            data: toChartData(streamData),
            laps: toLapData(streamData),
          }
        : null,
    [streamData],
  );

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {loading ? (
        <LoadingSkeleton />
      ) : error || !derived ? (
        <ErrorState
          message={error ?? "No activity data available"}
          onRetry={retry}
        />
      ) : (
        <ActivityChart
          data={derived.data}
          meta={derived.meta}
          laps={derived.laps}
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
      appInfo={{ name: "Activity Chart", version: "1.0.0" }}
      parseToolInput={(args) => {
        const next = args as ToolArgs | undefined;
        return next?.activity_id ? next : null;
      }}
      missingArgsMessage="No activity id was provided to the chart view."
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
