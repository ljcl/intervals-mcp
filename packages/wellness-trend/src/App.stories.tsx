import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  dailyData,
  emptyData,
  sdnnNoSleepData,
  weeklyData,
} from "./__fixtures__/wellness";
import { App } from "./App";

const meta = preview.meta({ component: App });

/** 30 days with whole-day gaps on 7-8 and 19 Oct: three panels, one date axis. */
export const Default = meta.story({
  args: { app: null, data: dailyData },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Wellness trend")).toBeVisible();
    await expect(canvas.getByText("1 Oct to 30 Oct 2026")).toBeVisible();
    await expect(canvas.getByText("HRV (rMSSD), ms")).toBeVisible();
    // ResponsiveContainer needs a resize tick before the charts mount.
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(".recharts-line-curve"),
      ).toHaveLength(3),
    );
  },
});

export const Mobile = meta.story({
  args: { app: null, data: dailyData, mode: "mobile" },
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

/** Past 90 days: weekly averages, one empty week as a gap. */
export const Weekly = meta.story({
  args: { app: null, data: weeklyData },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("11 May to 8 Nov 2026 · weekly averages"),
    ).toBeVisible();
  },
});

export const WeeklyMobile = meta.story({
  args: { app: null, data: weeklyData, mode: "mobile" },
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

/** An SDNN device with no sleep: the HRV panel names SDNN, no sleep panel. */
export const SdnnNoSleep = meta.story({
  args: { app: null, data: sdnnNoSleepData },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("HRV (SDNN), ms")).toBeVisible();
    await expect(canvas.queryByText("Sleep, h")).toBeNull();
  },
});

/** Records exist but carry none of the three: the empty state, no frame. */
export const Empty = meta.story({
  args: { app: null, data: emptyData },
  play: async ({ canvas, canvasElement }) => {
    await expect(
      canvas.getByText(
        "No HRV, resting heart rate or sleep recorded in this range.",
      ),
    ).toBeVisible();
    await expect(canvasElement.querySelector(".recharts-wrapper")).toBeNull();
  },
});

export const Dark = meta.story({
  args: { app: null, data: dailyData },
  globals: darkGlobals,
});
