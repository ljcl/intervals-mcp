import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, waitFor } from "storybook/test";
import { mockRuns, runsWithGap } from "./__fixtures__/runs";
import { TrendView } from "./TrendView";

const noop = () => {};

const meta = preview.meta({ component: TrendView });

/** The plot order the view derives: cadence-bearing runs, oldest first. */
const plotted = [...mockRuns]
  .filter((a) => a.averageCadence > 0)
  .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

/** Every clickable run mark, in plot order. */
const runMarks = (root: HTMLElement) =>
  root.querySelectorAll<SVGPathElement>(
    ".recharts-scatter path.recharts-symbols",
  );

/**
 * Click-to-select (ljcl/strava-mcp#275) was render-only smoke tested, so a broken click
 * target or an id mismatch could not fail CI. Clicking a plotted run must
 * report that run's id — the same callback the run picker drives.
 */
export const Default = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: fn(),
    selectedRunIds: new Set<string>(),
  },
  play: async ({ args, canvasElement, userEvent }) => {
    // ResponsiveContainer needs a resize tick before the marks mount.
    await waitFor(() =>
      expect(runMarks(canvasElement).length).toBeGreaterThan(0),
    );

    await userEvent.click(runMarks(canvasElement)[0]!);
    await expect(args.onRunClick).toHaveBeenCalledWith(plotted[0]!.id);
  },
});

export const Empty = meta.story({
  args: {
    activities: [],
    onRunClick: noop,
    selectedRunIds: new Set<string>(),
  },
});

/** Selected runs are outlined, so the overlay selection is legible. */
export const WithSelectedRuns = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set(["i10003", "i10013"]),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(runMarks(canvasElement).length).toBeGreaterThan(0),
    );

    const outlined = [...runMarks(canvasElement)].filter(
      (mark) => mark.getAttribute("stroke-width") === "2",
    );
    // One per selected run, on the cadence series only — the pace series
    // carries no selection stroke.
    expect(outlined).toHaveLength(2);
  },
});

/** A mark's centre x, read from its `translate(x, y)` transform. */
const markX = (mark: SVGPathElement) =>
  Number(
    /translate\(([-\d.]+)/.exec(mark.getAttribute("transform") ?? "")?.[1],
  );

/**
 * A three-week break in running (7 Jan to 31 Jan) is a stretch of empty
 * chart: the x axis is time, not run order. The 24 days across the break
 * must sit about eight times as far apart as the 3 days between the first
 * two runs; a category axis would space every run equally.
 */
export const WithGap = meta.story({
  args: {
    activities: runsWithGap,
    onRunClick: noop,
    selectedRunIds: new Set<string>(),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(runMarks(canvasElement).length).toBeGreaterThan(0),
    );

    // The cadence series is drawn first, in date order: runs on 1, 4, 7 Jan
    // then 31 Jan.
    const xs = [...runMarks(canvasElement)].slice(0, 4).map(markX);
    const across = xs[3]! - xs[2]!;
    const within = xs[1]! - xs[0]!;
    expect(across / within).toBeGreaterThan(6);
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set<string>(),
  },
});

export const Mobile = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set<string>(),
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

export const WithGapMobile = WithGap.extend({
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
