import { formatPace, formatShortDate } from "@intervals-mcp/data";
import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, waitFor } from "storybook/test";
import { mockRuns, runsWithGap, runsWithNullPace } from "./__fixtures__/runs";
import { TrendView } from "./TrendView";
import { type RunSummary } from "./types";

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

/** The marks of one scatter series: 0 is cadence, 1 is pace. */
const seriesMarks = (root: HTMLElement, series: 0 | 1) =>
  Array.from(
    root
      .querySelectorAll(".recharts-scatter")
      [series]?.querySelectorAll<SVGPathElement>("path.recharts-symbols") ?? [],
  );

/** Point at a mark's centre, as a hovering mouse would. */
const hoverMark = (
  userEvent: { pointer: (input: object) => Promise<void> },
  mark: SVGPathElement,
) => {
  const box = mark.getBoundingClientRect();
  return userEvent.pointer({
    target: mark,
    coords: {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    },
  });
};

const tooltipOf = (root: HTMLElement) =>
  root.querySelector(".recharts-tooltip-wrapper");

/**
 * Hover every mark of one series and check the tooltip names that mark's
 * run. Run dates are unique, so the date is what proves which run it is, and
 * a stale tooltip from the previous dot cannot satisfy the next one. Done
 * for every dot because a wrong tooltip depended on which dot it was.
 */
const expectHoverNamesRuns = async (
  root: HTMLElement,
  userEvent: { pointer: (input: object) => Promise<void> },
  series: 0 | 1,
  runs: RunSummary[],
) => {
  const marks = seriesMarks(root, series);
  expect(marks).toHaveLength(runs.length);
  for (const [i, run] of runs.entries()) {
    await hoverMark(userEvent, marks[i]!);
    await waitFor(() =>
      expect(tooltipOf(root)).toHaveTextContent(
        formatShortDate(run.date, "short"),
      ),
    );
    expect(tooltipOf(root)).toHaveTextContent(run.name);
    if (run.averagePace == null) {
      expect(tooltipOf(root)).not.toHaveTextContent("Pace");
    } else {
      expect(tooltipOf(root)).toHaveTextContent(formatPace(run.averagePace));
    }
  }
};

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

/**
 * Hovering a run's dot shows that run's tooltip, for every dot of both
 * series. The pace series reads the chart's own data: giving it a filtered
 * `data` of its own made the shared tooltip show another run (the last one)
 * for some dots. (Easy 6k appears twice; the date tells them apart.)
 */
export const HoverNamesRun = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set<string>(),
  },
  play: async ({ canvasElement, userEvent }) => {
    await waitFor(() =>
      expect(seriesMarks(canvasElement, 1).length).toBe(plotted.length),
    );

    await expectHoverNamesRuns(canvasElement, userEvent, 0, plotted);
    await expectHoverNamesRuns(canvasElement, userEvent, 1, plotted);
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

/**
 * Two runs recorded no speed. They keep their cadence dot but draw no pace
 * symbol, and the pace dots after them still belong to their own runs:
 * clicking or hovering a pace dot reports that run, not the one at the same
 * position in the full list.
 */
export const WithNullPace = meta.story({
  args: {
    activities: runsWithNullPace,
    onRunClick: fn(),
    selectedRunIds: new Set<string>(),
  },
  play: async ({ args, canvasElement, userEvent }) => {
    const withPace = runsWithNullPace.filter((r) => r.averagePace != null);
    await waitFor(() =>
      expect(seriesMarks(canvasElement, 1).length).toBe(withPace.length),
    );
    expect(seriesMarks(canvasElement, 0)).toHaveLength(runsWithNullPace.length);
    expect(withPace.length).toBeLessThan(runsWithNullPace.length);

    // Pace dots follow the runs that have a pace, oldest first: Easy 8k,
    // Tempo Intervals (Recovery Jog has none), Long Run, Threshold Run
    // (Easy 6k has none).
    await userEvent.click(seriesMarks(canvasElement, 1)[1]!);
    await userEvent.click(seriesMarks(canvasElement, 1)[3]!);
    await expect(args.onRunClick).toHaveBeenNthCalledWith(1, "i10003");
    await expect(args.onRunClick).toHaveBeenNthCalledWith(2, "i10006");

    // Hover follows the same pairing. The cadence dots cover every run, and
    // a run with no pace gets a tooltip without a pace line.
    await expectHoverNamesRuns(canvasElement, userEvent, 0, runsWithNullPace);
    await expectHoverNamesRuns(canvasElement, userEvent, 1, withPace);
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

export const HoverNamesRunMobile = HoverNamesRun.extend({
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

export const WithNullPaceMobile = WithNullPace.extend({
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
