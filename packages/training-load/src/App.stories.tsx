import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import { mockTrainingLoadData } from "./__fixtures__/weeks";
import { App } from "./App";
import { buildLoadSubtitle } from "./normalize";

const meta = preview.meta({ component: App });

export const Default = meta.story({
  args: { app: null, data: mockTrainingLoadData },
  play: async ({ canvas }) => {
    // The card opens with a title (#247): scrolled back in a transcript, a
    // bare chart cannot say which period it belongs to.
    await expect(canvas.getByText("Training load")).toBeVisible();
    await expect(
      canvas.getByText(buildLoadSubtitle(mockTrainingLoadData)),
    ).toBeVisible();
  },
});

/**
 * Interaction test (#164): the legend's Trend toggle removes the rolling
 * trend line while the weekly bars stay. Recharts drops a hidden Line's path
 * from the SVG, so the curve count proves the line really left the chart.
 */
export const LegendToggleHidesTrend = meta.story({
  args: { app: null, data: mockTrainingLoadData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(curveCount()).toBe(1));

    const trendToggle = canvas.getByRole("button", { name: "Toggle Trend" });
    await expect(trendToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(trendToggle);

    await expect(trendToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(0));
    await expect(barCount()).toBeGreaterThan(0);
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockTrainingLoadData },
  globals: darkGlobals,
});

export const Mobile = meta.story({
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
