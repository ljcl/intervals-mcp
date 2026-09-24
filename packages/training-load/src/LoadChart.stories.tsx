import preview from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect } from "storybook/test";
import { mockWeeks } from "./__fixtures__/weeks";
import { LoadChart } from "./LoadChart";

const meta = preview.meta({ component: LoadChart });

export const Default = meta.story({
  args: { weeks: mockWeeks, showTrend: true, showWarnings: true },
  play: async ({ canvas }) => {
    // Axis ticks come from the shared UTC formatter, the same one behind the
    // header subtitle and the narration. `toLocaleDateString` rendered "Jun
    // 15" beside a "15 Jun" header in an en-US host. `preserveEnd` always
    // draws the last tick, so this one is reliably on screen.
    await expect(canvas.getByText("15 Jun")).toBeInTheDocument();
  },
});

export const TrendHidden = meta.story({
  args: { weeks: mockWeeks, showTrend: false, showWarnings: true },
});

export const WarningsHidden = meta.story({
  args: { weeks: mockWeeks, showTrend: true, showWarnings: false },
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
