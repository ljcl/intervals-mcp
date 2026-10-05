import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, waitFor } from "storybook/test";
import {
  allFailedStreams,
  allRunsWithoutStreams,
  duplicateNameStreams,
  gappyStreams,
  mockStreams,
  oneRunWithoutStreams,
  partiallyFailedStreams,
  partiallyLoadedStreams,
  progressStreams,
} from "./__fixtures__/overlay-streams";
import { OverlayView } from "./OverlayView";

const noop = () => {};

const meta = preview.meta({ component: OverlayView });

const bothRuns = new Set(["i10003", "i10013"]);
const twoLongRuns = new Set(["i10004", "i10009"]);

export const EmptyState = meta.story({
  args: {
    selectedRunIds: new Set<string>(),
    streams: new Map(),
    requestStream: noop,
    retryStream: noop,
  },
});

export const WithData = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: mockStreams,
    requestStream: noop,
    retryStream: noop,
  },
});

/**
 * Interaction test (ljcl/strava-mcp#164): the x-axis pills reslice the overlay onto a
 * time grid, and a run's legend toggle hides its line. Recharts drops a
 * hidden Line's path from the SVG, so the curve count is the ground truth
 * that the toggle really removed the series.
 */
export const SwitchAxisAndHideRun = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: mockStreams,
    requestStream: noop,
    retryStream: noop,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    // ResponsiveContainer needs a resize tick before the lines mount.
    await waitFor(() => expect(curveCount()).toBe(2));

    const minPill = canvas.getByRole("button", { name: "min" });
    await userEvent.click(minPill);
    await expect(minPill).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "km" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const runToggle = canvas.getByRole("button", {
      name: /Toggle Tempo Intervals/,
    });
    await userEvent.click(runToggle);
    await expect(runToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(1));
  },
});

/**
 * Dark host theme (ljcl/strava-mcp#117): the overlay tooltip must render via the shared
 * themed Tooltip, not Recharts' default white box. Hover a line to verify.
 */
export const WithDataDark = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: mockStreams,
    requestStream: noop,
    retryStream: noop,
  },
  globals: {
    ...darkGlobals,
    hostTheme: "claude",
  },
});

/** One run drawn, the other still loading: the chart stays up. */
export const Loading = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: partiallyLoadedStreams,
    requestStream: noop,
    retryStream: noop,
  },
});

/** Nothing drawn yet: skeleton instead of an empty axis frame. */
export const LoadingFirstRun = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: new Map(),
    requestStream: noop,
    retryStream: noop,
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("status")).toBeInTheDocument();
    expect(canvasElement.querySelector(".recharts-surface")).toBeNull();
  },
});

/**
 * Nothing drawn yet, and a run's fetch has sent progress (#55). The skeleton
 * shows that line, the same way the app's first load does.
 */
export const LoadingWithProgress = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: progressStreams,
    requestStream: noop,
    retryStream: noop,
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Reading streams for Intervals 5x1k",
    );
  },
});

/**
 * A failed run used to vanish from the overlay, leaving the user with a
 * silently-incomplete comparison and a console.error (ljcl/strava-mcp#250). It now reports
 * the failure by name with a retry, while the runs that did load stay drawn.
 */
export const OneRunFailed = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: partiallyFailedStreams,
    requestStream: noop,
    retryStream: fn(),
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(1),
    );
    await expect(
      canvas.getByText("Could not load stream data for Intervals 5x1k."),
    ).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.retryStream).toHaveBeenCalledWith("i10013");
  },
});

/** Every selected run failed: the error replaces the chart entirely. */
export const AllRunsFailed = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: allFailedStreams,
    requestStream: noop,
    retryStream: fn(),
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    expect(canvasElement.querySelector(".recharts-surface")).toBeNull();
    await expect(
      canvas.getByText(
        "Could not load stream data for 2 of the selected runs.",
      ),
    ).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.retryStream).toHaveBeenCalledTimes(2);
  },
});

/**
 * One selected run recorded no streams (#65). It is named in a note and left
 * out of the lines, the other run stays drawn, and there is no retry: a retry
 * cannot succeed, so the "Try again" an error would offer would be dead.
 */
export const RunWithoutStreams = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: oneRunWithoutStreams,
    requestStream: noop,
    retryStream: fn(),
  },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(1),
    );
    await expect(
      canvas.getByText("No recorded streams for Intervals 5x1k."),
    ).toBeVisible();
    // Only the run with streams is in the legend.
    expect(
      canvas.queryByRole("button", { name: /Toggle Intervals 5x1k/ }),
    ).toBeNull();
    expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(canvas.queryByRole("alert")).toBeNull();
  },
});

/** Every selected run is stream-less: an empty state, not bare axes. */
export const NoSelectedRunHasStreams = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: allRunsWithoutStreams,
    requestStream: noop,
    retryStream: fn(),
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(
      canvas.getByText(
        "None of the selected runs has recorded streams to overlay.",
      ),
    ).toBeVisible();
    expect(canvasElement.querySelector(".recharts-surface")).toBeNull();
    expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(canvas.queryByRole("alert")).toBeNull();
  },
});

/**
 * A run with a mid-run cadence/pace dropout: the line for that run breaks
 * across the gap instead of bridging it or dipping to a fake zero, while
 * the intact run keeps drawing normally.
 */
export const WithGaps = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: gappyStreams,
    requestStream: noop,
    retryStream: noop,
  },
  play: async ({ canvasElement }) => {
    // Both runs still draw one <path> each (recharts keeps one path per
    // <Line>, even with connectNulls off): the gap shows up as a second
    // "M" (moveto) command inside that path's `d`, splitting it into two
    // disjoint subpaths instead of bridging across the null samples or
    // flattening them to zero.
    await waitFor(() => {
      const paths = canvasElement.querySelectorAll("path.recharts-line-curve");
      expect(paths.length).toBe(2);
      const moveCommandCounts = Array.from(paths).map(
        (path) => (path.getAttribute("d")?.match(/M/g) ?? []).length,
      );
      expect(Math.max(...moveCommandCounts)).toBeGreaterThan(1);
    });
  },
});

/**
 * Two selected runs are both named "Long Run". Each is labelled with its own
 * date (11 Jan, 25 Jan) so the legend, and the tooltip it shares a name
 * with, can tell them apart; a run with a unique name stays bare.
 */
export const DuplicateNames = meta.story({
  args: {
    selectedRunIds: twoLongRuns,
    streams: duplicateNameStreams,
    requestStream: noop,
    retryStream: noop,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(2),
    );
    await expect(
      canvas.getByRole("button", { name: "Toggle Long Run · 11 Jan 26" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Toggle Long Run · 25 Jan 26" }),
    ).toBeVisible();

    const surface = canvasElement.querySelector(".recharts-wrapper")!;
    const box = surface.getBoundingClientRect();
    await userEvent.pointer({
      target: surface,
      coords: {
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 3,
      },
    });
    await waitFor(() => {
      const tooltip = canvasElement.querySelector(".recharts-tooltip-wrapper");
      expect(tooltip).toHaveTextContent("Long Run · 11 Jan 26");
      expect(tooltip).toHaveTextContent("Long Run · 25 Jan 26");
    });
  },
});

export const Mobile = meta.story({
  args: {
    selectedRunIds: bothRuns,
    streams: mockStreams,
    requestStream: noop,
    retryStream: noop,
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

export const DuplicateNamesMobile = DuplicateNames.extend({
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
