import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import { mockRuns } from "./__fixtures__/runs";
import { ZonesView } from "./ZonesView";

const meta = preview.meta({ component: ZonesView });

export const Default = meta.story({
  args: { activities: mockRuns },
});

export const Empty = meta.story({
  args: { activities: [] },
});

/** The bars' fill opacity, in plot order. */
const barOpacities = (root: HTMLElement) =>
  [...root.querySelectorAll(".recharts-bar-rectangle path")].map((bar) =>
    bar.getAttribute("fill-opacity"),
  );

/**
 * `mockRuns` has no run faster than 4:00/km, so Threshold is empty and only
 * three bars draw. Each keeps its own shade by zone (Tempo 0.8, Moderate 0.6,
 * Easy 0.4): shading by plot position would paint Tempo as Threshold.
 */
export const WithEmptyZone = meta.story({
  args: { activities: mockRuns },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(barOpacities(canvasElement)).toHaveLength(3));
    expect(barOpacities(canvasElement)).toEqual(["0.8", "0.6", "0.4"]);
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: { activities: mockRuns },
});

export const Mobile = meta.story({
  args: { activities: mockRuns, mode: "mobile" },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <div style={{ height: 260 }}>
          <StoryFn />
        </div>
      </MobileCardShell>
    ),
  ],
});

export const WithEmptyZoneMobile = WithEmptyZone.extend({
  args: { mode: "mobile" },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <div style={{ height: 260 }}>
          <StoryFn />
        </div>
      </MobileCardShell>
    ),
  ],
});
