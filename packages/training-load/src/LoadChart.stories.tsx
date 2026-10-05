import preview from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  layoffWeeks,
  mockRunOnlyTrainingLoadData,
  mockTrainingLoadData,
} from "./__fixtures__/weeks";
import { LoadChart } from "./LoadChart";

const meta = preview.meta({ component: LoadChart });

const shown = { showTrend: true, showWarnings: true, showLoad: true };

/** Four-digit weekly loads, so the right axis carries its widest ticks. */
const heavyLoadData = {
  ...mockTrainingLoadData,
  weeks: mockTrainingLoadData.weeks.map((week) => ({
    ...week,
    load: week.load * 4,
    loadByType: Object.fromEntries(
      Object.entries(week.loadByType).map(([type, load]) => [type, load * 4]),
    ),
  })),
};

const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * No axis title may land on a tick label. A right-hand axis lists its ticks
 * from the axis line outward, so an `insideRight` title inside too narrow an
 * axis sits on them.
 */
async function expectTitlesClearOfTicks(root: HTMLElement) {
  const titles = () => [...root.querySelectorAll("text.recharts-label")];
  const ticks = () => [
    ...root.querySelectorAll("text.recharts-cartesian-axis-tick-value"),
  ];
  // ResponsiveContainer needs a resize tick before the chart mounts.
  await waitFor(() => {
    expect(titles().map((title) => title.textContent)).toContain("Load");
    expect(ticks().length).toBeGreaterThan(0);
  });
  const tickBoxes = ticks().map((tick) => ({
    text: tick.textContent,
    box: tick.getBoundingClientRect(),
  }));
  for (const title of titles()) {
    const hit = tickBoxes.find(({ box }) =>
      intersects(title.getBoundingClientRect(), box),
    );
    expect(
      hit,
      `the "${title.textContent}" title overlaps the "${hit?.text}" tick`,
    ).toBeUndefined();
  }
}

export const Default = meta.story({
  args: { data: mockTrainingLoadData, ...shown },
  play: async ({ canvas, canvasElement }) => {
    // Axis ticks come from the shared UTC formatter, the same one behind the
    // header subtitle and the narration. `toLocaleDateString` rendered "Jun
    // 22" beside a "22 Jun" header in an en-US host. `preserveEnd` always
    // draws the last tick, so this one is reliably on screen.
    await expect(canvas.getByText("22 Jun")).toBeInTheDocument();

    await expectTitlesClearOfTicks(canvasElement);

    // The week in progress holds only the days so far, so its load is a
    // hollow point of its own and the solid line stops at the last complete
    // week: 12 solid points for 12 complete weeks, and one hollow point.
    const dots = (selector: string) =>
      canvasElement.querySelectorAll(`circle.recharts-line-dot${selector}`)
        .length;
    await waitFor(() => expect(dots('[fill="var(--chart-power)"]')).toBe(12));
    await expect(dots('[fill^="color-mix"]')).toBe(1);
  },
});

/** Run-only scope: the load line drops the rides, so the skipped week reads 0. */
export const RunOnly = meta.story({
  args: { data: mockRunOnlyTrainingLoadData, ...shown },
  play: async ({ canvasElement }) => {
    await expectTitlesClearOfTicks(canvasElement);
  },
});

/** Four-digit load ticks still clear the right axis title. */
export const HeavyLoad = meta.story({
  args: { data: heavyLoadData, ...shown },
  play: async ({ canvasElement }) => {
    await expectTitlesClearOfTicks(canvasElement);
    const ticks = [
      ...canvasElement.querySelectorAll(
        "text.recharts-cartesian-axis-tick-value",
      ),
    ].map((tick) => tick.textContent ?? "");
    // The point of the story: a tick wide enough to threaten the title.
    expect(ticks.some((text) => text.replace(",", "").length >= 4)).toBe(true);
  },
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
