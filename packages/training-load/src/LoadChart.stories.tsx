import preview from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect } from "storybook/test";
import {
  layoffWeeks,
  mockRunOnlyTrainingLoadData,
  mockTrainingLoadData,
} from "./__fixtures__/weeks";
import { LoadChart } from "./LoadChart";

const meta = preview.meta({ component: LoadChart });

const shown = { showTrend: true, showWarnings: true, showLoad: true };

export const Default = meta.story({
  args: { data: mockTrainingLoadData, ...shown },
  play: async ({ canvas }) => {
    // Axis ticks come from the shared UTC formatter, the same one behind the
    // header subtitle and the narration. `toLocaleDateString` rendered "Jun
    // 22" beside a "22 Jun" header in an en-US host. `preserveEnd` always
    // draws the last tick, so this one is reliably on screen.
    await expect(canvas.getByText("22 Jun")).toBeInTheDocument();
  },
});

/** Run-only scope: the load line drops the rides, so the skipped week reads 0. */
export const RunOnly = meta.story({
  args: { data: mockRunOnlyTrainingLoadData, ...shown },
});

export const TrendHidden = meta.story({
  args: { data: mockTrainingLoadData, ...shown, showTrend: false },
});

export const WarningsHidden = meta.story({
  args: { data: mockTrainingLoadData, ...shown, showWarnings: false },
});

/** The load line and its right axis leave together; the bars keep the full width. */
export const LoadHidden = meta.story({
  args: { data: mockTrainingLoadData, ...shown, showLoad: false },
});

/**
 * A layoff that is still going on: the bars and the trend line run on to
 * the current week instead of stopping at the last run.
 */
export const Layoff = meta.story({
  args: {
    data: { ...mockTrainingLoadData, weeks: layoffWeeks },
    ...shown,
  },
  play: async ({ canvas }) => {
    // `preserveEnd` always draws the last tick: the current week, not the
    // last week with a run.
    await expect(canvas.getByText("29 Jun")).toBeInTheDocument();
  },
});

export const Empty = meta.story({
  args: { data: { ...mockTrainingLoadData, weeks: [] }, ...shown },
});

export const Mobile = meta.story({
  args: { data: mockTrainingLoadData, ...shown, mode: "mobile" },
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
