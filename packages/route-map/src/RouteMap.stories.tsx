import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell, ViewToolRegistry } from "@intervals-mcp/ui";
import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import {
  annotatedActivity,
  loopActivity,
  noGeometryActivity,
  pointToPointRoute,
  profiledRoute,
  streamLoopActivity,
  waypointedActivity,
  waypointedRoute,
} from "./__fixtures__/routes";
import { RouteMap } from "./RouteMap";
import { type RouteMapData } from "./types";

const meta = preview.meta({ component: RouteMap });

/* The basemap is the app's default view, but it renders live OpenFreeMap
 * tiles that need the network and can't render deterministically. The grid
 * stories pin `basemapEnabled: false` (exactly the app's tiles-unavailable
 * fallback) so the browser-mode story tests stay hermetic; the two Basemap
 * stories still exercise the real default view. */

export const ActivityLoop = meta.story({
  args: { data: loopActivity, basemapEnabled: false },
});

export const MetricColoredTrack = meta.story({
  args: { data: streamLoopActivity, basemapEnabled: false },
});

export const DarkMetricColoredTrack = meta.story({
  globals: darkGlobals,
  args: { data: streamLoopActivity, basemapEnabled: false },
});

/**
 * Interaction test (#164): switching the colour metric re-bins the track and
 * reformats the gradient scale legend. The scale's min/max labels use the
 * metric's own unit, so "bpm" appearing there is proof the heart-rate series
 * became active (and the browser-mode test exercises the HR-coloured track).
 */
export const SwitchColorMetric = meta.story({
  args: { data: streamLoopActivity, basemapEnabled: false },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The default active metric for a run is pace; its scale reads "/km".
    const pacePill = await canvas.findByRole("button", { name: "Pace" });
    await expect(pacePill).toHaveAttribute("aria-pressed", "true");

    const hrPill = canvas.getByRole("button", { name: "Heart rate" });
    await userEvent.click(hrPill);

    await expect(hrPill).toHaveAttribute("aria-pressed", "true");
    await expect(pacePill).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      const scaleLabels = [...canvasElement.querySelectorAll("span")]
        .map((el) => el.textContent ?? "")
        .filter((text) => text.includes("bpm"));
      expect(scaleLabels).toHaveLength(2);
    });
  },
});

export const SavedRoute = meta.story({
  args: { data: pointToPointRoute, basemapEnabled: false },
});

/**
 * A saved route with the elevation profile the server now resolves for a
 * `route_id` (#264): the strip, elevation colouring, kilometre splits, and the
 * altitude sentence in the narration all light up for a route, none of which
 * the geometry-only `SavedRoute` above can show (#311).
 *
 * A route carries `distance` + `altitude` and nothing else, so elevation is
 * the *only* metric series — and a lone series renders no picker at all, just
 * the metre-unit colour scale. Gradient is not offerable: the server never
 * sends `grade_smooth` for a route.
 */
export const SavedRouteWithProfile = meta.story({
  args: { data: profiledRoute, basemapEnabled: false },
  play: async ({ canvas, canvasElement }) => {
    const altitude = profiledRoute.streams?.altitude ?? [];

    // The elevation strip is a route's headline win from #264.
    await expect(
      canvas.getByRole("img", {
        name: `Elevation profile of ${profiledRoute.name}`,
      }),
    ).toBeInTheDocument();

    // No pace, heart rate, power, or gradient stream to pick between, and a
    // lone series suppresses the picker entirely.
    expect(
      canvas.queryAllByRole("button", {
        name: /^(Pace|Speed|Heart rate|Power|Elevation|Gradient)$/,
      }),
    ).toHaveLength(0);

    // The colour scale still renders, either side of the ramp bar, in the
    // elevation series' unit. Its endpoints are the 5th/95th percentiles, not
    // the altitude range, so only the unit is assertable here.
    const bar = canvasElement.querySelector<HTMLElement>(
      'span[style*="linear-gradient"]',
    );
    expect(bar).not.toBeNull();
    expect(bar?.previousElementSibling?.textContent).toMatch(/^\d+ m$/);
    expect(bar?.nextElementSibling?.textContent).toMatch(/^\d+ m$/);

    // Both newly-reachable narration sentences for a route.
    const description =
      canvas.getByRole("img", { name: /^Map of/ }).querySelector("desc")
        ?.textContent ?? "";
    expect(description).toContain(
      `Altitude ranges from ${Math.round(Math.min(...altitude))} m to ${Math.round(Math.max(...altitude))} m.`,
    );
    expect(description).toContain("The track is coloured by elevation.");

    // The distance stream also earns a route the km-split layer and its
    // toggle: 12 marks over 12.54 km, the last still clear of the finish.
    await expect(
      canvas.getByRole("button", { name: "Toggle Splits" }),
    ).toBeInTheDocument();
    const kmMarks = [...canvasElement.querySelectorAll("title")].filter((el) =>
      /^\d+ km$/.test(el.textContent ?? ""),
    );
    expect(kmMarks).toHaveLength(12);
  },
});

/**
 * Keyboard/pointerless zoom (#167): the grid view carries visible zoom
 * in/out/reset buttons and the focused SVG responds to +/- and arrow keys, so
 * the offline grid is fully operable without a wheel or a mouse. The buttons
 * disable at the frame edges (nothing to zoom out of at base), and the SVG
 * viewBox shrinking below the 640-unit base frame is proof the view zoomed.
 */
export const GridZoomControls = meta.story({
  args: { data: loopActivity, basemapEnabled: false },
  play: async ({ canvas, userEvent }) => {
    const map = canvas.getByRole("img", { name: /Golden Gate Park Loop/ });
    const viewWidth = () =>
      Number(map.getAttribute("viewBox")?.split(" ")[2] ?? Number.NaN);
    const zoomIn = canvas.getByRole("button", { name: "Zoom in" });
    const zoomOut = canvas.getByRole("button", { name: "Zoom out" });
    const reset = canvas.getByRole("button", { name: "Reset zoom" });

    // At the base frame only zoom-in is actionable.
    expect(viewWidth()).toBe(640);
    expect(zoomOut).toBeDisabled();
    expect(reset).toBeDisabled();

    // The zoom-in button shrinks the viewBox and enables the other controls.
    await userEvent.click(zoomIn);
    await waitFor(() => expect(viewWidth()).toBeLessThan(640));
    await expect(zoomOut).toBeEnabled();
    await expect(reset).toBeEnabled();

    // Reset restores the base frame and re-disables the pair.
    await userEvent.click(reset);
    await waitFor(() => expect(viewWidth()).toBe(640));
    await expect(reset).toBeDisabled();

    // The focused SVG zooms via the + key and resets via 0 — no pointer.
    map.focus();
    await userEvent.keyboard("+");
    await waitFor(() => expect(viewWidth()).toBeLessThan(640));
    await userEvent.keyboard("0");
    await waitFor(() => expect(viewWidth()).toBe(640));
  },
});

export const DarkActivityLoop = meta.story({
  globals: darkGlobals,
  args: { data: loopActivity, basemapEnabled: false },
});

export const NoGeometry = meta.story({
  args: { data: noGeometryActivity, basemapEnabled: false },
});

export const MobileActivityLoop = meta.story({
  args: { data: loopActivity, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const AnnotatedTrack = meta.story({
  args: { data: annotatedActivity, basemapEnabled: false },
});

export const WaypointedTrack = meta.story({
  args: { data: waypointedActivity, basemapEnabled: false },
});

export const WaypointedRoute = meta.story({
  args: { data: waypointedRoute, basemapEnabled: false },
});

/**
 * Interaction test: the footer legend's Waypoints item toggles the marker
 * layer. Each waypoint titles both a track diamond and an elevation-strip
 * diamond, so two matches collapse to zero once hidden.
 */
export const ToggleWaypoints = meta.story({
  args: { data: waypointedActivity, basemapEnabled: false },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // SVG <title> children of the marker paths (getByTitle only matches
    // direct svg > title children, so query them directly).
    const gelMarkers = () =>
      [...canvasElement.querySelectorAll("title")].filter(
        (el) => el.textContent === "Gel 1 · 0.5 km",
      );
    await waitFor(() => expect(gelMarkers()).toHaveLength(2));

    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle Waypoints" }),
    );

    await waitFor(() => expect(gelMarkers()).toHaveLength(0));
  },
});

export const Basemap = meta.story({
  args: { data: annotatedActivity },
});

export const MobileBasemap = meta.story({
  args: { data: annotatedActivity, mode: "mobile" },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const MobileWaypointedTrack = meta.story({
  args: { data: waypointedActivity, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const MobileAnnotatedTrack = meta.story({
  args: { data: annotatedActivity, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const MobileMetricColoredTrack = meta.story({
  args: { data: streamLoopActivity, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const MobileSavedRoute = meta.story({
  args: { data: pointToPointRoute, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const MobileSavedRouteWithProfile = meta.story({
  args: { data: profiledRoute, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

/**
 * Host-driven view tool (#278): the model calls `set-viewport` and the map
 * frames that stretch of the course. Asserted through the SVG `viewBox`,
 * which is the actual zoom state — the registry, the distance lookup, and the
 * component's `applyView` all have to line up for it to move.
 */
function ModelDriven({ data }: { data: RouteMapData }) {
  // Stable across renders: a registry rebuilt each render would have the
  // handler installed on an instance the button no longer holds.
  const [registry] = useState(() => new ViewToolRegistry());
  const [said, setSaid] = useState("");
  const call = (args: Record<string, unknown>) => {
    void registry.invoke("set-viewport", args).then((r) => setSaid(r.text));
  };
  return (
    <>
      <RouteMap
        data={data}
        basemapEnabled={false}
        viewToolRegistry={registry}
      />
      <button
        type="button"
        data-testid="call-set-viewport"
        onClick={() => call({ fromKm: 1, toKm: 1.2 })}
      >
        call set-viewport
      </button>
      <button
        type="button"
        data-testid="call-reset"
        onClick={() => call({ reset: true })}
      >
        call reset
      </button>
      <p data-testid="tool-said">{said}</p>
    </>
  );
}

export const ModelDrivenViewport = meta.story({
  args: { data: streamLoopActivity, basemapEnabled: false },
  render: ({ data }) => <ModelDriven data={data} />,
  play: async ({ canvasElement, userEvent }) => {
    const svg = () => canvasElement.querySelector("svg[role='img']");
    const said = () =>
      canvasElement.querySelector("[data-testid='tool-said']")?.textContent;
    const full = svg()?.getAttribute("viewBox");
    expect(full).toBeTruthy();

    await userEvent.click(
      canvasElement.querySelector<HTMLButtonElement>(
        "[data-testid='call-set-viewport']",
      )!,
    );
    // A ~200 m stretch of a 2.2 km loop: a small bounding box, so the frame
    // must genuinely shrink. (Half the loop would legitimately fill it.)
    await waitFor(() => expect(said()).toMatch(/Framed 1\.0.1\.2 km/));
    const zoomed = svg()!.getAttribute("viewBox")!;
    expect(zoomed).not.toBe(full);
    expect(Number(zoomed.split(" ")[2])).toBeLessThan(
      Number(full!.split(" ")[2]),
    );

    await userEvent.click(
      canvasElement.querySelector<HTMLButtonElement>(
        "[data-testid='call-reset']",
      )!,
    );
    await waitFor(() => expect(svg()?.getAttribute("viewBox")).toBe(full));
  },
});
