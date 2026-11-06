import {
  type AppMode,
  AppShell,
  ErrorState,
  type HostCtx,
  useServerToolData,
  useServerToolFetcher,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { type App } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { RouteMap } from "./RouteMap";
import { type RouteArgs, type RouteMapData } from "./types";
import { useRouteAmend } from "./useRouteAmend";

const DATA_TOOL = "get-route-map-data";

/** The get-route-map-data arguments for the view the host asked for. */
export function routeDataArgs(args: RouteArgs): Record<string, unknown> {
  const out: Record<string, unknown> = { route_id: args.route_id };
  if (args.version !== undefined) out.version = args.version;
  if (args.compare_to_version !== undefined)
    out.compare_to_version = args.compare_to_version;
  if (args.waypoints !== undefined) out.waypoints = args.waypoints;
  if (args.waypoints_version !== undefined)
    out.waypoints_version = args.waypoints_version;
  return out;
}

/**
 * The arguments that load a version made on the map: drawn over the version
 * it was made from, and with the caller's waypoints moved from the version
 * their km were read on. Used as the fetch key, so each version loads once.
 */
export function editedVersionArgs(
  args: RouteArgs,
  version: number,
  baseVersion: number,
  waypointsVersion: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    route_id: args.route_id,
    version,
    compare_to_version: baseVersion,
  };
  if (args.waypoints !== undefined && args.waypoints.length > 0) {
    out.waypoints = args.waypoints;
    out.waypoints_version = waypointsVersion;
  }
  return out;
}

interface RouteViewProps {
  app: App | null;
  args: RouteArgs;
  hostCtx: HostCtx;
  mode: AppMode;
  viewToolRegistry: ViewToolRegistry | null;
  /** Set false to force the offline grid (tests and stories). */
  basemapEnabled?: boolean;
}

/**
 * A stored route (`view-route-map` with `route_id`). The version the host
 * asked for loads on mount (`useServerToolData`); each version made on the
 * map loads once through the keyed fetcher, keyed by its arguments, and the
 * map then shows it. The waypoints keep the version their km were read on
 * (`waypoints_version`), so the server moves them with each change.
 */
export function RouteView({
  app,
  args,
  hostCtx,
  mode,
  viewToolRegistry,
  basemapEnabled,
}: RouteViewProps) {
  const initial = useServerToolData<RouteMapData>(
    app,
    DATA_TOOL,
    routeDataArgs(args),
  );
  const edited = useServerToolFetcher<RouteMapData>(
    app,
    DATA_TOOL,
    (key) => JSON.parse(key) as Record<string, unknown>,
  );
  /** The version made on the map last: its fetch key and what changed. */
  const [shown, setShown] = useState<{ key: string; summary: string } | null>(
    null,
  );

  const entry = shown ? edited.entries.get(shown.key) : undefined;
  const state = shown
    ? {
        data: entry?.data ?? null,
        // A key not in the map yet was requested in this same event.
        loading: entry?.loading ?? true,
        error: entry?.error ?? null,
        progress: entry?.progress ?? null,
        retry: () => edited.retry(shown.key),
      }
    : initial;
  const route = state.data?.route;
  // The version the waypoints' km were read on: as the caller said, else
  // the version that first loaded.
  const waypointsVersion =
    args.waypoints_version ?? initial.data?.route?.version ?? 1;

  const amend = useRouteAmend(app ?? undefined, route, (version, summary) => {
    if (!route) return;
    const key = JSON.stringify(
      editedVersionArgs(args, version, route.version, waypointsVersion),
    );
    edited.request(key);
    setShown({ key, summary });
  });

  return (
    <AppShell hostCtx={hostCtx} mode={mode} app={app}>
      {state.loading ? (
        <LoadingSkeleton progress={state.progress} />
      ) : state.error || !state.data ? (
        <ErrorState
          message={state.error ?? "No route map data available"}
          onRetry={state.retry}
        />
      ) : (
        <RouteMap
          data={state.data}
          mode={mode}
          app={app ?? undefined}
          viewToolRegistry={viewToolRegistry}
          basemapEnabled={basemapEnabled}
          routeEdit={app ? amend : null}
          contextNote={shown?.summary ?? null}
        />
      )}
    </AppShell>
  );
}
