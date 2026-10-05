import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  mockRunOnlyTrainingLoadData,
  mockTrainingLoadData,
} from "./__fixtures__/weeks";
import { App } from "./App";
import { buildLoadSubtitle, buildScopeNote } from "./normalize";

const meta = preview.meta({ component: App });

/** Whole-body load (runs and rides), CTL/ATL read from intervals.icu. */
export const WholeBody = meta.story({
  args: { app: null, data: mockTrainingLoadData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The card opens with a title (ljcl/strava-mcp#247): scrolled back in a transcript, a
    // bare chart cannot say which period it belongs to.
    await expect(canvas.getByText("Training load")).toBeVisible();
    await expect(
      canvas.getByText(buildLoadSubtitle(mockTrainingLoadData)),
    ).toBeVisible();
    // The scope note says what the load and the fitness tiles add up.
    await expect(
      canvas.getByText(buildScopeNote(mockTrainingLoadData)),
    ).toBeVisible();

    // The legend's Load toggle removes the load line. Recharts drops a hidden
    // Line's path from the SVG, so the stroke-matched curve count proves the
    // line really left the chart while the trend line stayed.
    const curves = (stroke: string) =>
      canvasElement.querySelectorAll(
        `path.recharts-line-curve[stroke="${stroke}"]`,
      ).length;
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(1));

    const loadToggle = canvas.getByRole("button", { name: "Toggle Load" });
    await expect(loadToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(loadToggle);

    await expect(loadToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(0));
    await expect(curves("var(--chart-cadence)")).toBe(1);
  },
});

/** Run-only load, CTL/ATL computed locally from the runs. */
export const RunOnly = meta.story({
  args: { app: null, data: mockRunOnlyTrainingLoadData },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(buildScopeNote(mockRunOnlyTrainingLoadData)),
    ).toBeVisible();
  },
});

/**
 * Interaction test (ljcl/strava-mcp#164): the legend's Trend toggle removes the rolling
 * trend line while the weekly bars and the load line stay. Recharts drops a
 * hidden Line's path from the SVG, so the curve count proves the line really
 * left the chart.
 */
export const LegendToggleHidesTrend = meta.story({
  args: { app: null, data: mockTrainingLoadData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    // ResponsiveContainer needs a resize tick before the chart mounts. Two
    // curves: the trend line and the load line.
    await waitFor(() => expect(curveCount()).toBe(2));

    const trendToggle = canvas.getByRole("button", { name: "Toggle Trend" });
    await expect(trendToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(trendToggle);

    await expect(trendToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(1));
    await expect(barCount()).toBeGreaterThan(0);
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockTrainingLoadData },
  globals: darkGlobals,
});

export const MobileWholeBody = meta.story({
  args: { app: null, data: mockTrainingLoadData, mode: "mobile" },
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

export const MobileRunOnly = meta.story({
  args: { app: null, data: mockRunOnlyTrainingLoadData, mode: "mobile" },
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
