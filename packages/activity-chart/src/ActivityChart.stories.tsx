import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import { dynamicsRun } from "./__fixtures__/dynamics-run";
import { gappyRun } from "./__fixtures__/gappy-run";
import { manualEntry, timeOnlyRecording } from "./__fixtures__/manual-entry";
import { poolSwim } from "./__fixtures__/pool-swim";
import { tempoRun } from "./__fixtures__/tempo-run";
import { ActivityChart } from "./ActivityChart";
import { extractMeta, toChartData, toLapData } from "./normalize";

const meta = preview.meta({ component: ActivityChart });

export const TempoRun = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: toLapData(tempoRun),
  },
});

export const PoolSwim = meta.story({
  args: {
    data: toChartData(poolSwim),
    meta: extractMeta(poolSwim),
    laps: toLapData(poolSwim),
  },
});

export const DarkTempoRun = meta.story({
  globals: darkGlobals,
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: toLapData(tempoRun),
  },
});

/**
 * Interaction test (#164): toggling a legend item hides its series. The SVG
 * <desc> narration is rebuilt from the visible metrics, so it doubles as a
 * semantic assertion that the heart-rate line really left the chart (and
 * the browser-mode test exercises the toggled-off state).
 */
export const LegendToggleHidesSeries = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: toLapData(tempoRun),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const descText = () =>
      canvasElement.querySelector("desc")?.textContent ?? "";
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(descText()).toContain("Heart rate ranges"));

    const hrToggle = canvas.getByRole("button", { name: "Toggle Heart Rate" });
    await expect(hrToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(hrToggle);

    await expect(hrToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(descText()).not.toContain("Heart rate ranges"));
    // Pace is untouched by the toggle and stays drawn.
    await expect(descText()).toContain("Pace ranges");
  },
});

/**
 * Keyboard parity for the legend's hover isolation (#251). Hovering a legend
 * entry dims the other series; before this, a keyboard user tabbing to the
 * same control got the focus ring and none of the isolation. The dimming is
 * driven by `data-hovered` on the chart area, so that is what is asserted.
 */
export const LegendFocusIsolatesSeries = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: toLapData(tempoRun),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const area = () => canvasElement.querySelector("[data-hovered]");
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Toggle Heart Rate" }),
      ).toBeInTheDocument(),
    );
    expect(area()).toBeNull();

    const hrToggle = canvas.getByRole("button", { name: "Toggle Heart Rate" });
    hrToggle.focus();
    await waitFor(() =>
      expect(area()).toHaveAttribute("data-hovered", "heartrate"),
    );

    // ...and blurring clears it, so focus does not leave the chart stuck dim.
    await userEvent.tab();
    await waitFor(() => expect(area()).toBeNull());
  },
});

export const CyclingRide = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: {
      ...extractMeta(tempoRun),
      activityType: "Ride",
      isRunning: false,
      isSwimming: false,
    },
    laps: toLapData(tempoRun),
  },
});

export const DarkPoolSwim = meta.story({
  globals: darkGlobals,
  args: {
    data: toChartData(poolSwim),
    meta: extractMeta(poolSwim),
    laps: toLapData(poolSwim),
  },
});

/**
 * Task 2: null-safe rendering. Synthetic run with deliberate gaps in
 * heartrate, velocity (pace), cadence, and altitude. The lines must break
 * at each gap instead of drawing a fabricated zero, spike, or interpolated
 * value, and the Recovery band (null distance) must still shade correctly.
 */
export const GappyRun = meta.story({
  args: {
    data: toChartData(gappyRun),
    meta: extractMeta(gappyRun),
    laps: toLapData(gappyRun),
  },
});

export const GappyRunMobile = meta.story({
  args: {
    data: toChartData(gappyRun),
    meta: extractMeta(gappyRun),
    laps: toLapData(gappyRun),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const MobileRun = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: toLapData(tempoRun),
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

export const MobileSwim = meta.story({
  args: {
    data: toChartData(poolSwim),
    meta: extractMeta(poolSwim),
    laps: toLapData(poolSwim),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

/**
 * The x-axis brush (#35) renders with both travellers, and the zoom window
 * survives a preset switch because the range is controlled state joined to
 * the chart-tree memo deps (an uncontrolled Brush would reset to full range
 * whenever the tree rebuilds).
 */
/**
 * Overlap avoidance: a workout with many short back-to-back reps used to stack
 * its lap labels into an unreadable smear (labels sit at each band's top-left,
 * so contiguous narrow bands crowd their neighbours). `selectLapLabels` now
 * drops labels that can't clear the previous one, so only a legible subset
 * renders. Shown in the narrow mobile card, where a 16-band interval workout
 * cannot fit every label; the play test asserts the dense run is thinned.
 */
const denseLaps = Array.from({ length: 16 }, (_, i) => {
  const start = i * 195;
  return {
    name: i % 2 === 0 ? `Rep ${i / 2 + 1}` : "Recovery",
    startTime: start,
    endTime: start + 195,
    startDistance: 0,
    endDistance: 0,
    isRest: i % 2 === 1,
  };
});

export const DenseIntervalLabels = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: denseLaps,
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelector(".recharts-reference-area"),
      ).not.toBeNull(),
    );
    // Band labels render as recharts-label <text> nodes carrying the lap name.
    const drawn = [
      ...canvasElement.querySelectorAll("text.recharts-label"),
    ].filter((el) => /Rep|Recovery/.test(el.textContent ?? ""));
    // Not every one of the 16 bands can label itself at 360px wide, so the
    // dense run is thinned rather than stacked into an unreadable smear.
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(denseLaps.length);
  },
});

/**
 * A manual entry has no streams at all. The card keeps its title and says
 * so, instead of rendering bare axes with an empty legend and an empty
 * preset selector — which read as a broken app rather than "nothing to
 * chart" (#248).
 */
export const NoStreams = meta.story({
  args: {
    data: toChartData(manualEntry),
    meta: extractMeta(manualEntry),
    laps: toLapData(manualEntry),
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Evening Strength Session")).toBeVisible();
    await expect(
      canvas.getByText(
        "This activity has no recorded streams, so there is nothing to chart.",
      ),
    ).toBeVisible();
    // No axis frame, and none of the controls that imply plottable series.
    expect(canvasElement.querySelector(".recharts-surface")).toBeNull();
    expect(canvas.queryByRole("button", { name: "Form" })).toBeNull();
  },
});

/**
 * The harder case: a time stream exists, so the payload parses into chart
 * points, but no metric was recorded. `data.length` alone would let this
 * through — the empty guard has to test the metric set too.
 */
export const TimeStreamOnly = meta.story({
  args: {
    data: toChartData(timeOnlyRecording),
    meta: extractMeta(timeOnlyRecording),
    laps: toLapData(timeOnlyRecording),
  },
  play: async ({ canvas, canvasElement }) => {
    expect(toChartData(timeOnlyRecording).length).toBeGreaterThan(0);
    await expect(canvas.getByText("Treadmill Shakeout")).toBeVisible();
    expect(canvasElement.querySelector(".recharts-surface")).toBeNull();
  },
});

export const MobileNoStreams = meta.story({
  args: {
    data: toChartData(manualEntry),
    meta: extractMeta(manualEntry),
    laps: toLapData(manualEntry),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const BrushZoom = meta.story({
  args: {
    data: toChartData(tempoRun),
    meta: extractMeta(tempoRun),
    laps: toLapData(tempoRun),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() =>
      expect(canvasElement.querySelector(".recharts-brush")).not.toBeNull(),
    );
    expect(
      canvasElement.querySelectorAll(".recharts-brush-traveller"),
    ).toHaveLength(2);

    // Switching presets rebuilds the memoized tree; the brush must survive.
    const formPill = canvas.getByRole("button", { name: "Form" });
    await userEvent.click(formPill);
    await waitFor(() =>
      expect(canvasElement.querySelector(".recharts-brush")).not.toBeNull(),
    );
  },
});

/**
 * Task 3: running-dynamics overlays. The "Form" preset draws ground contact
 * time, vertical oscillation, vertical ratio, and step length alongside
 * cadence/pace/heart rate, each on its own hidden Y axis (the scales differ
 * too widely to share one). The <desc> narration switches from a min-max
 * range to an average for these four, and the legend offers all four only
 * because `dynamicsRun` recorded them: an activity without dynamics never
 * offers them at all.
 */
export const RunningDynamicsForm = meta.story({
  args: {
    data: toChartData(dynamicsRun),
    meta: extractMeta(dynamicsRun),
    laps: toLapData(dynamicsRun),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Form" })).toBeInTheDocument(),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Form" }));

    const descText = () =>
      canvasElement.querySelector("desc")?.textContent ?? "";
    await waitFor(() =>
      expect(descText()).toContain("Ground contact time averages"),
    );
    expect(descText()).toContain("Vertical oscillation averages");
    expect(descText()).toContain("Vertical ratio averages");
    expect(descText()).toContain("Step length averages");

    await expect(
      canvas.getByRole("button", { name: "Toggle Ground Contact Time" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Toggle Vertical Oscillation" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Toggle Vertical Ratio" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Toggle Step Length" }),
    ).toBeVisible();

    // Every dynamics axis is `hide`, so none of them render: only the
    // left/right visible axes exist, no matter how many series are drawn.
    expect(
      canvasElement.querySelectorAll(".recharts-yAxis").length,
    ).toBeLessThanOrEqual(2);
  },
});

export const RunningDynamicsFormMobile = meta.story({
  args: {
    data: toChartData(dynamicsRun),
    meta: extractMeta(dynamicsRun),
    laps: toLapData(dynamicsRun),
    mode: "mobile",
  },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
  play: async ({ canvas, canvasElement, userEvent }) => {
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Form" })).toBeInTheDocument(),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Form" }));

    const descText = () =>
      canvasElement.querySelector("desc")?.textContent ?? "";
    await waitFor(() =>
      expect(descText()).toContain("Ground contact time averages"),
    );

    // Mobile drops the Smooth control and Grade, but not dynamics; only the
    // left/right axes are ever visible regardless of screen size: the four
    // dynamics axes stay hidden, so the narrow card never overlaps axes.
    expect(
      canvasElement.querySelectorAll(".recharts-yAxis").length,
    ).toBeLessThanOrEqual(2);
  },
});
