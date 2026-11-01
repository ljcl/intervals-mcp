import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  emptyZonesData,
  hrAndPaceData,
  hrOnlyData,
  hrZoneMismatchData,
  hrZoneSet,
  mockZonesData,
  paceOnlyData,
  paceZoneSet,
} from "./__fixtures__/zones";
import { App } from "./App";
import { buildZonesSubtitle } from "./normalize";

const meta = preview.meta({ component: App });

export const Default = meta.story({
  args: { app: null, data: mockZonesData },
  play: async ({ canvas }) => {
    // The card opens with a title (ljcl/strava-mcp#247), and the subtitle names the set on
    // screen — the pill row only appears when both sets exist.
    await expect(canvas.getByText(mockZonesData.name)).toBeVisible();
    await expect(
      canvas.getByText(buildZonesSubtitle(mockZonesData, hrZoneSet)),
    ).toBeVisible();
  },
});

/**
 * Interaction test: switching the zone-set pill swaps the chart from the
 * 5-bucket heart-rate set to the 6-bucket power set — the bar count proves
 * the chart really re-rendered.
 */
export const SwitchToPower = meta.story({
  args: { app: null, data: mockZonesData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(barCount()).toBe(5));

    const powerPill = canvas.getByRole("button", { name: "Power" });
    await userEvent.click(powerPill);

    await expect(powerPill).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(barCount()).toBe(6));
  },
});

/**
 * A run with heart rate and pace zones: the "Pace" pill swaps the 5-bucket
 * heart rate chart for the 7-bucket pace chart, and the footer says the time
 * is grade-adjusted.
 */
export const SwitchToPace = meta.story({
  args: { app: null, data: hrAndPaceData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    await waitFor(() => expect(barCount()).toBe(5));

    const pacePill = canvas.getByRole("button", { name: "Pace" });
    await userEvent.click(pacePill);

    await expect(pacePill).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(barCount()).toBe(7));
    await expect(
      canvas.getByText(buildZonesSubtitle(hrAndPaceData, paceZoneSet)),
    ).toBeVisible();
    await expect(
      canvas.getByText("Zones: time by grade-adjusted pace (GAP)"),
    ).toBeVisible();
  },
});

/** A run without heart rate shows the Pace chart, not the empty state. */
export const PaceOnly = meta.story({
  args: { app: null, data: paceOnlyData },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(".recharts-bar-rectangle").length,
      ).toBe(7),
    );
    await expect(canvas.queryByText(/No zone data/)).toBeNull();
  },
});

export const PaceOnlyMobile = meta.story({
  args: { app: null, data: paceOnlyData, mode: "mobile" },
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

export const HeartRateOnly = meta.story({
  args: { app: null, data: hrOnlyData },
});

/**
 * No zone set to chart and no reason from the server. The card says so and
 * claims nothing about sensors, since the app cannot know about them.
 */
export const NoZoneData = meta.story({
  args: { app: null, data: emptyZonesData },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("No zone data to show for this activity."),
    ).toBeVisible();
    await expect(canvas.queryByText(/sensor/i)).toBeNull();
  },
});

/**
 * Heart rate zones dropped because the recorded bounds and zone times
 * disagree. The card gives the server's own reason, the same line the text
 * tools print, not a guess about a missing sensor.
 */
export const HeartRateZonesOmitted = meta.story({
  args: { app: null, data: hrZoneMismatchData },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(hrZoneMismatchData.hrZoneWarning!, { exact: false }),
    ).toBeVisible();
    await expect(canvas.queryByText(/sensor/i)).toBeNull();
  },
});

export const HeartRateZonesOmittedMobile = meta.story({
  args: { app: null, data: hrZoneMismatchData, mode: "mobile" },
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

export const Dark = meta.story({
  args: { app: null, data: mockZonesData },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: { app: null, data: mockZonesData, mode: "mobile" },
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
