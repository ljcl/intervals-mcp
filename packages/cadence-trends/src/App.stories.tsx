import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { type App as McpApp } from "@modelcontextprotocol/ext-apps";
import { expect, waitFor, within } from "storybook/test";
import { mockRuns } from "./__fixtures__/runs";
import { App } from "./App";
import { buildCadenceSubtitle } from "./normalize";
import { type CadenceTrendData } from "./types";

const mockData: CadenceTrendData = { weeks: 6, activities: mockRuns };

const meta = preview.meta({ component: App });

export const Default = meta.story({
  args: { app: null, data: mockData },
  play: async ({ canvas }) => {
    // The card opens with a title (ljcl/strava-mcp#247): scrolled back in a transcript, a
    // bare chart cannot say which runs or window it belongs to.
    await expect(canvas.getByText("Cadence trends")).toBeVisible();
    await expect(
      canvas.getByText(buildCadenceSubtitle(mockRuns.length, mockData.weeks)),
    ).toBeVisible();
  },
});

/**
 * Keyboard-accessible run selection (ljcl/strava-mcp#169). Previously the only way to build an
 * overlay comparison was clicking Recharts dots, which carry no tabindex or key
 * handling. The run picker below the Trend/Scatter charts lets a keyboard user
 * select and deselect runs: focus a chip, activate it, and its `aria-pressed`
 * flips while the selection bar and count update. A second activation deselects.
 */
export const KeyboardRunSelection = meta.story({
  args: { app: null, data: mockData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const group = canvas.getByRole("group", { name: /compare runs/i });
    const chip = within(group).getByRole("button", {
      name: /Tempo Intervals/,
    });
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    // Select via keyboard: focus the chip and press Enter.
    chip.focus();
    await expect(chip).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(group).toHaveAccessibleName(/1 of 4 selected/);
    // The run now appears in the selection bar with a remove control.
    await expect(
      canvas.getByRole("button", { name: "Remove Tempo Intervals" }),
    ).toBeInTheDocument();

    // Deselect via keyboard: Space toggles it back off.
    await userEvent.keyboard(" ");
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(group).toHaveAccessibleName(/0 of 4 selected/);
    await expect(
      within(canvasElement).queryByRole("button", {
        name: "Remove Tempo Intervals",
      }),
    ).toBeNull();
  },
});

/**
 * #65, end to end through the keyed fetcher: the server answers a stream-less
 * run with a `noStreams` payload, not an error. The overlay names that run
 * and draws the other, and offers no retry.
 */
const streamlessApp = {
  getHostCapabilities: () => undefined,
  callServerTool: async ({
    arguments: args,
  }: {
    arguments?: Record<string, unknown>;
  }) => {
    const id = String(args?.activity_id);
    const payload =
      id === "i10013"
        ? {
            activityId: id,
            activityType: "Run",
            name: "Intervals 5x1k",
            streams: { time: [] },
            laps: [],
            noStreams: true,
          }
        : {
            activityId: id,
            activityType: "Run",
            name: "Tempo Intervals",
            streams: {
              time: [0, 60, 120, 180, 240],
              distance: [0, 220, 440, 660, 880],
              cadence: [84, 86, 87, 86, 85],
            },
          };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
} as unknown as McpApp;

export const OverlayRunWithoutStreams = meta.story({
  args: { app: streamlessApp, data: mockData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const group = canvas.getByRole("group", { name: /compare runs/i });
    await userEvent.click(
      within(group).getByRole("button", { name: /Tempo Intervals/ }),
    );
    await userEvent.click(
      within(group).getByRole("button", { name: /Intervals 5x1k/ }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Overlay" }));

    await expect(
      await canvas.findByText("No recorded streams for Intervals 5x1k."),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(1),
    );
    expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockData },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: { app: null, data: mockData, mode: "mobile" },
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
