import preview from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect } from "storybook/test";
import { layoffWeeks, mockWeeks } from "./__fixtures__/weeks";
import { LoadChart } from "./LoadChart";

const meta = preview.meta({ component: LoadChart });

export const Default = meta.story({
  args: { weeks: mockWeeks, showTrend: true, showWarnings: true },
  play: async ({ canvas }) => {
    // Axis ticks come from the shared UTC formatter, the same one behind the
    // header subtitle and the narration. `toLocaleDateString` rendered "Jun
    // 22" beside a "22 Jun" header in an en-US host. `preserveEnd` always
    // draws the last tick, so this one is reliably on screen.
    await expect(canvas.getByText("22 Jun")).toBeInTheDocument();
  },
});

export const TrendHidden = meta.story({
  args: { weeks: mockWeeks, showTrend: false, showWarnings: true },
});

export const WarningsHidden = meta.story({
  args: { weeks: mockWeeks, showTrend: true, showWarnings: false },
});

/**
 * A layoff that is still going on: the bars and the trend line run on to
 * the current week instead of stopping at the last run.
 */
export const Layoff = meta.story({
  args: { weeks: layoffWeeks, showTrend: true, showWarnings: true },
  play: async ({ canvas }) => {
    // `preserveEnd` always draws the last tick: the current week, not the
    // last week with a run.
    await expect(canvas.getByText("29 Jun")).toBeInTheDocument();
  },
});

export const Empty = meta.story({
  args: { weeks: [], showTrend: true, showWarnings: true },
});

export const Mobile = meta.story({
  args: {
    weeks: mockWeeks,
    showTrend: true,
    showWarnings: true,
    mode: "mobile",
  },
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
