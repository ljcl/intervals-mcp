import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  baselineRun,
  compareData,
  compareDataManualSide,
  gappyPair,
  hrOnlyPair,
  manualRun,
  raceRun,
} from "./__fixtures__/runs";
import { CompareActivities } from "./CompareActivities";

const meta = preview.meta({ component: CompareActivities });

export const SteadyVsRace = meta.story({
  args: {
    a: baselineRun,
    b: raceRun,
    compare: compareData,
  },
});

export const DarkSteadyVsRace = meta.story({
  globals: darkGlobals,
  args: {
    a: baselineRun,
    b: raceRun,
    compare: compareData,
  },
});

/**
 * Interaction test (ljcl/strava-mcp#164): the metric pills swap which stream pair is
 * overlaid and the axis pills re-align the grid. The SVG <desc> narration is
 * rebuilt from the active metric, so "bpm" appearing there proves the
 * heart-rate overlay really rendered (and the browser-mode test exercises
 * that state).
 */
export const SwitchMetricAndAxis = meta.story({
  // Interaction-only test: keep it a runnable browser-mode test, but off the
  // autodocs page where SteadyVsRace already shows the overlay.
  tags: ["!autodocs"],
  args: {
    a: baselineRun,
    b: raceRun,
    compare: compareData,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const descText = () =>
      canvasElement.querySelector("desc")?.textContent ?? "";
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(descText()).toContain("min/km"));

    const hrPill = canvas.getByRole("button", { name: "Heart Rate" });
    await userEvent.click(hrPill);
    await expect(hrPill).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(descText()).toContain("bpm"));

    // Both fixtures record distance, so the axis defaults to Distance.
    const timePill = canvas.getByRole("button", { name: "Time" });
    await expect(timePill).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(timePill);
    await expect(timePill).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Distance" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
});

/** The overlay still renders when the aggregate summary fetch fails. */
export const WithoutSummary = meta.story({
  args: {
    a: baselineRun,
    b: raceRun,
    compare: null,
  },
});

/** Treadmill pair: heart rate only, time axis, no axis/metric toggles. */
export const HeartRateOnly = meta.story({
  args: {
    a: hrOnlyPair[0],
    b: hrOnlyPair[1],
    compare: null,
  },
});

/**
 * Task 2: null-safe rendering. Each side has a gap in a different stream.
 * The overlay's two lines must each break at their own gap independently,
 * never fill it with an interpolated or fabricated value.
 */
export const GappyStreams = meta.story({
  args: {
    a: gappyPair[0],
    b: gappyPair[1],
    compare: null,
  },
});

/**
 * #65: one side recorded no streams (a manual entry). The server sends that as
 * a `noStreams` payload, not an error, so the delta tiles still load and the
 * overlay says there is nothing to draw. Nothing here is an error, so there
 * is no retry to offer: it could not succeed.
 */
export const OneSideNoStreams = meta.story({
  args: {
    a: baselineRun,
    b: manualRun,
    compare: compareDataManualSide,
  },
  play: async ({ canvas }) => {
    // The summary tiles survive.
    await expect(canvas.getByText("Distance")).toBeVisible();
    await expect(canvas.getByText("Elevation")).toBeVisible();
    // The overlay explains itself instead of drawing one lonely line.
    await expect(
      canvas.getByText(
        "These activities have no overlapping streams to overlay.",
      ),
    ).toBeVisible();
    expect(canvas.queryByRole("alert")).toBeNull();
    expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
  },
});

export const MobileCompare = meta.story({
  args: {
    a: baselineRun,
    b: raceRun,
    compare: compareData,
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  // layout: fullscreen removes Storybook's outer padding so the preview
  // matches what actually ships: the card sits directly against the
  // iframe edge, with only our 3px outer margin.
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});
