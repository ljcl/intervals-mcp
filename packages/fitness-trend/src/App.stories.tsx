import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { expect, waitFor } from "storybook/test";
import {
  mockBaseArgs,
  mockFitnessTrendData,
  mockNoLoadData,
  mockRestProjectionData,
  mockRunOnlyFitnessTrendData,
} from "./__fixtures__/trend";
import { App } from "./App";
import { buildTrendSubtitle } from "./normalize";

const meta = preview.meta({ component: App });

/**
 * A fake host app whose `callServerTool` answers `get-fitness-trend-data`
 * from the two fixtures below, keyed on `runOnly`. Same shape the real host
 * returns, so the toggle's `useServerToolFetcher` fetch actually resolves in
 * Storybook instead of hanging on a null app.
 */
const toggleApp = {
  callServerTool: async ({
    arguments: args,
  }: {
    arguments?: Record<string, unknown>;
  }) => {
    const data = args?.runOnly
      ? mockRunOnlyFitnessTrendData
      : mockFitnessTrendData;
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
  getHostCapabilities: () => undefined,
} as unknown as ReturnType<typeof useApp>["app"];

/**
 * Ninety days of build ending deep in fatigue, with a three-week taper solved
 * to land on form +12 on race day — the dashed continuation and the plan list
 * are two views of one server-side solve.
 */
export const WholeBody = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    // The card opens with a title (#247): scrolled back in a transcript, a
    // bare chart cannot say which window it belongs to.
    await expect(canvas.getByText("Fitness trend")).toBeVisible();
    await expect(
      canvas.getByText(buildTrendSubtitle(mockFitnessTrendData)),
    ).toBeVisible();
    // The plan reads in words as well as curves.
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
    await expect(canvas.getByText("Week 1")).toBeVisible();
    // Scope toggle: whole body is active, and it says where the numbers came from.
    await expect(
      canvas.getByRole("button", { name: "Whole body" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(/From intervals.icu/)).toBeVisible();
  },
});

/**
 * `runOnly: true` from the start (the tool call's own default): the toggle
 * opens on "Runs only", and the computed-locally disclaimer is visible.
 */
export const RunsOnly = meta.story({
  args: {
    app: null,
    data: mockRunOnlyFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: true,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "Runs only" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(/Computed locally/)).toBeVisible();
    // Run-only has no taper solved in this fixture, only a rest projection.
    await expect(canvas.queryByText(/Plan to/)).toBeNull();
  },
});

/**
 * Switching scope: clicking "Runs only" fetches and caches the other scope
 * through the fake host app above; switching back to "Whole body" is instant
 * (the original mount data, never re-fetched) and still shows the taper plan.
 */
export const Switching = meta.story({
  args: {
    app: toggleApp,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/From intervals.icu/)).toBeVisible();
    await expect(canvas.getByText(/Plan to/)).toBeVisible();

    const runsOnly = canvas.getByRole("button", { name: "Runs only" });
    runsOnly.click();

    await waitFor(() =>
      expect(canvas.getByText(/Computed locally/)).toBeVisible(),
    );
    await expect(canvas.queryByText(/Plan to/)).toBeNull();

    // Switching back to whole body is instant: the mount data is cached,
    // not re-fetched, and the taper plan reappears.
    const wholeBody = canvas.getByRole("button", { name: "Whole body" });
    wholeBody.click();
    await waitFor(() =>
      expect(canvas.getByText(/From intervals.icu/)).toBeVisible(),
    );
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
  },
});

/** No target date: the forward half is the zero-load rest projection. */
export const RestProjection = meta.story({
  args: {
    app: null,
    data: mockRestProjectionData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "Toggle Rest projection" }),
    ).toBeVisible();
    await expect(canvas.queryByText(/Plan to/)).toBeNull();
  },
});

/**
 * Interaction test: hiding Form drops the TSB line and its right-hand axis,
 * leaving the fitness area and fatigue line. Recharts removes a hidden Line's
 * path from the SVG, so the curve count proves it really left the chart.
 */
export const LegendToggleHidesForm = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    const areaCount = () =>
      canvasElement.querySelectorAll("path.recharts-area-area").length;
    // ResponsiveContainer needs a resize tick before the chart mounts. Five
    // lines: fatigue, form, and the three dashed continuations — fitness is
    // an Area when recorded but a Line when planned.
    await waitFor(() => expect(curveCount()).toBe(5));

    const formToggle = canvas.getByRole("button", { name: "Toggle Form" });
    await expect(formToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(formToggle);

    await expect(formToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(3));
    await expect(areaCount()).toBeGreaterThan(0);
  },
});

/**
 * Hiding the plan takes the dashed curves and the week list with it — the
 * list is the plan's numbers, so leaving it behind would contradict the chart.
 */
export const PlanHidden = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle Taper plan" }),
    );
    await waitFor(() => expect(canvas.queryByText(/Plan to/)).toBeNull());
  },
});

/**
 * Fatigue and ramp bands overlap in this window, so each kind gets its own
 * legend toggle; hiding one leaves the other shaded.
 */
export const BandKindsToggleIndependently = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const shadeCount = () =>
      canvasElement.querySelectorAll(".recharts-reference-area").length;
    await waitFor(() =>
      expect(shadeCount()).toBe(mockFitnessTrendData.bands.length),
    );

    const fatigue = canvas.getByRole("button", {
      name: /Toggle Deep fatigue/,
    });
    await userEvent.click(fatigue);

    const rampBands = mockFitnessTrendData.bands.filter(
      (band) => band.kind === "steep-ramp",
    ).length;
    await waitFor(() => expect(shadeCount()).toBe(rampBands));
    await expect(
      canvas.getByRole("button", { name: /Toggle Steep ramp/ }),
    ).toHaveAttribute("aria-pressed", "true");
  },
});

/** No training load, CTL, or ATL recorded anywhere in the window. */
export const NoRecordedLoad = meta.story({
  args: {
    app: null,
    data: mockNoLoadData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(/No training load recorded in this window/),
    ).toBeVisible();
  },
});

export const Dark = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});
