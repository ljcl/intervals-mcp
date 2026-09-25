import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, waitFor } from "storybook/test";
import {
  allFailedStreams,
  gappyStreams,
  mockStreams,
  partiallyFailedStreams,
  partiallyLoadedStreams,
} from "./__fixtures__/overlay-streams";
import { OverlayView } from "./OverlayView";

const noop = () => {};

const meta = preview.meta({ component: OverlayView });

const bothRuns = new Set(["i10003", "i10013"]);

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
 * Interaction test (#164): the x-axis pills reslice the overlay onto a
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
 * Dark host theme (#117): the overlay tooltip must render via the shared
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
 * A failed run used to vanish from the overlay, leaving the user with a
 * silently-incomplete comparison and a console.error (#250). It now reports
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
    // The gappy run renders as two disjoint path segments (before/after the
    // gap) plus one whole path for the intact run: more curves than a plain
    // two-run overlay, proving the line actually breaks rather than
    // bridging or flattening to zero.
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBeGreaterThan(2),
    );
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
