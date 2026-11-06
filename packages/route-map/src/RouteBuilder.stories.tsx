import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import {
  comparedStoredRouteMap,
  olderStoredRouteMap,
  storedRouteMap,
  warnedStoredRouteMap,
} from "./__fixtures__/storedRoute";
import { RouteMap } from "./RouteMap";
import { describeOperation } from "./routeEdit";
import { type RouteMapData } from "./types";
import { type EditNotice, type RouteAmend } from "./useRouteAmend";

const meta = preview.meta({ component: RouteMap });

/* A stored route (`view-route-map` with `route_id`): the line by section,
 * via points, km markers and the edit controls. The stories use the offline
 * grid (`basemapEnabled: false`) so the browser-mode tests stay hermetic.
 * The edit wiring is a local fake: it shows the status line an edit gives
 * and sends nothing. */

function useFakeEdit(): RouteAmend {
  const [notice, setNotice] = useState<EditNotice | null>(null);
  return {
    busy: false,
    notice,
    amend: (op) =>
      setNotice({ tone: "info", text: `${describeOperation(op)}…` }),
  };
}

function EditableRoute({
  data,
  mode,
}: {
  data: RouteMapData;
  mode?: "mobile" | "desktop";
}) {
  const routeEdit = useFakeEdit();
  return (
    <RouteMap
      data={data}
      mode={mode}
      basemapEnabled={false}
      routeEdit={routeEdit}
    />
  );
}

/** Version 3 of 3: each section has its colour, and the edit controls show. */
export const StoredRoute = meta.story({
  args: { data: storedRouteMap, basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} />,
});

export const DarkStoredRoute = meta.story({
  globals: darkGlobals,
  args: { data: storedRouteMap, basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} />,
});

export const MobileStoredRoute = meta.story({
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
  args: { data: storedRouteMap, mode: "mobile", basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} mode="mobile" />,
});

/** Version 3 over version 2: the old line is dashed, the change has a halo. */
export const ComparedStoredRoute = meta.story({
  args: { data: comparedStoredRouteMap, basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} />,
  play: async ({ canvas, canvasElement }) => {
    await expect(
      await canvas.findByText(/^Compared with version 2:/),
    ).toBeVisible();
    await expect(
      canvasElement.querySelector("path[data-layer='compare']"),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector("path[data-layer='changed']"),
    ).not.toBeNull();
  },
});

export const MobileComparedStoredRoute = meta.story({
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
  args: { data: comparedStoredRouteMap, mode: "mobile", basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} mode="mobile" />,
});

/** Section notes and a moved pin, each with its km. */
export const WarnedStoredRoute = meta.story({
  args: { data: warnedStoredRouteMap, basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} />,
  play: async ({ canvas }) => {
    const list = await canvas.findByRole("list", { name: "Route warnings" });
    await expect(list.querySelectorAll("li")).toHaveLength(3);
  },
});

/** An older version: no edit controls, and a note that says why. */
export const OlderStoredRoute = meta.story({
  args: { data: olderStoredRouteMap, basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} />,
});

/**
 * Interaction test: select a via point, then remove it. The status line
 * says what the edit does while it is with the server.
 */
export const RemoveViaPoint = meta.story({
  args: { data: storedRouteMap, basemapEnabled: false },
  render: ({ data }) => <EditableRoute data={data} />,
  play: async ({ canvas, userEvent }) => {
    const v2 = await canvas.findByRole("button", { name: /^v2 · / });
    await userEvent.click(v2);
    await expect(v2).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Remove v2" }));
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent("Remove point v2…"),
    );
  },
});
