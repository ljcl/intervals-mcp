import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  emptyZonesData,
  hrOnlyData,
  hrZoneSet,
  mockZonesData,
} from "./__fixtures__/zones";
import { App } from "./App";
import { buildZonesSubtitle } from "./normalize";

const meta = preview.meta({ component: App });

export const Default = meta.story({
  args: { app: null, data: mockZonesData },
  play: async ({ canvas }) => {
    // The card opens with a title (#247), and the subtitle names the set on
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

export const HeartRateOnly = meta.story({
  args: { app: null, data: hrOnlyData },
});

export const NoZoneData = meta.story({
  args: { app: null, data: emptyZonesData },
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
