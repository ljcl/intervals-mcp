import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  emptySegmentProgressData,
  mockSegmentProgressData,
  sparseSegmentProgressData,
} from "./__fixtures__/efforts";
import { App } from "./App";

const meta = preview.meta({ component: App });

/**
 * Eight efforts on a climb across a season: the times drift down while
 * average heart rate drops faster — the "same effort, less strain" read the
 * chart exists for.
 */
export const Default = meta.story({
  args: { app: null, data: mockSegmentProgressData },
});

/**
 * Three efforts and no heart rate monitor: the trend stats fall back to the
 * gap against the personal best and the overlay legend disappears.
 */
export const SparseHistory = meta.story({
  args: { app: null, data: sparseSegmentProgressData },
});

/** A date range with nothing in it still renders the segment header. */
export const NoEfforts = meta.story({
  args: { app: null, data: emptySegmentProgressData },
});

/**
 * Interaction test: the legend's heart-rate toggle removes the overlay line
 * while the effort-time line stays. Recharts drops a hidden Line's path from
 * the SVG, so the curve count proves the series really left the chart.
 */
export const LegendToggleHidesHeartrate = meta.story({
  args: { app: null, data: mockSegmentProgressData },
  tags: ["!autodocs"],
  play: async ({ canvas, canvasElement, userEvent }) => {
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(curveCount()).toBe(2));

    const toggle = canvas.getByRole("button", {
      name: "Toggle Avg heart rate",
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);

    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(1));
  },
});

/**
 * Interaction test: expanding an effort row reveals the metrics that would
 * crowd the summary line, including the parent activity id.
 */
export const ExpandEffortRow = meta.story({
  args: { app: null, data: mockSegmentProgressData },
  tags: ["!autodocs"],
  play: async ({ canvas, userEvent }) => {
    const row = canvas.getByRole("button", { name: /26 Apr 26/ });
    await expect(canvas.queryByText("Max HR")).toBeNull();

    await userEvent.click(row);

    await waitFor(() => expect(canvas.getByText("Max HR")).toBeVisible());
    await expect(canvas.getByText("140007")).toBeVisible();
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockSegmentProgressData },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: { app: null, data: mockSegmentProgressData, mode: "mobile" },
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
