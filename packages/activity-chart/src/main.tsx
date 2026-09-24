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
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ActivityChart } from "./ActivityChart";
import { extractMeta, toChartData, toLapData } from "./normalize";
import { type ActivityStreamData } from "./types";
import "./global.css";

interface ToolArgs {
  activity_id: string;
}

/**
 * Tools this view exposes to the host and model. Declared at module
 * scope because they are registered before `connect()`; `ActivityChart`
 * installs the implementation once it owns the brush window.
 */
const VIEW_TOOLS: ViewToolDefinition[] = [
  {
    name: "set-brush-window",
    title: "Zoom the chart",
    description:
      "Zoom the activity chart's x-axis to one window of the activity, given either in kilometres from the start or in seconds of elapsed time. Use it to put the part of the run being discussed on screen — a surge, a climb, an interval — rather than describing where to look. Pass reset to show the whole activity again.",
    inputSchema: optionalObjectSchema({
      fromKm: {
        type: "number",
        description:
          "Start of the window, in km from the start. Use with toKm for a distance window.",
        minimum: 0,
      },
      toKm: {
        type: "number",
        description: "End of the window, in km from the start.",
        minimum: 0,
      },
      fromSeconds: {
        type: "number",
        description:
          "Start of the window, in seconds of elapsed time. Use with toSeconds for a time window.",
        minimum: 0,
      },
      toSeconds: {
        type: "number",
        description: "End of the window, in seconds of elapsed time.",
        minimum: 0,
      },
      reset: {
        type: "boolean",
        description: "Zoom back out to the whole activity.",
      },
    }),
  },
];

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
