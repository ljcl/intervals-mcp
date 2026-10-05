import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import {
  MobileCardShell,
  type ModelContextApp,
  ViewToolRegistry,
  type ViewToolResult,
} from "@intervals-mcp/ui";
import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import {
  baselineRun,
  compareData,
  compareDataManualSide,
  gappyPair,
  hrOnlyPair,
  manualRun,
  noPowerRide,
  noPowerRun,
  raceRun,
} from "./__fixtures__/runs";
import { CompareActivities } from "./CompareActivities";
import { type ActivityStreamData, type CompareData } from "./types";

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

/**
 * Host-driven view tool (#68): the model calls `set-metric` and the card
 * moves its metric and axis pills. Asserted through what the athlete would
 * see (the pill state) and what the model is told (the reply and the context
 * summary).
 */
function ModelDrivenCompare({
  a,
  b,
  compare,
}: {
  a: ActivityStreamData;
  b: ActivityStreamData;
  compare: CompareData | null;
}) {
  // Stable across renders: a registry rebuilt each render would have the
  // handler installed on an instance the buttons no longer hold.
  const [registry] = useState(() => new ViewToolRegistry());
  const [reply, setReply] = useState<ViewToolResult | null>(null);
  const [summary, setSummary] = useState("");
  const [app] = useState<ModelContextApp>(() => ({
    getHostCapabilities: () => ({ updateModelContext: {} }),
    updateModelContext: async ({ content }) => {
      setSummary(content.map((c) => c.text).join(""));
    },
  }));
  const call = (args: Record<string, unknown>) => {
    void registry.invoke("set-metric", args).then(setReply);
  };
  return (
    <>
      <CompareActivities
        a={a}
        b={b}
        compare={compare}
        app={app}
        viewToolRegistry={registry}
      />
      <button
        type="button"
        data-testid="call-heart-rate-by-time"
        onClick={() => call({ metric: "heartrate", axis: "time" })}
      >
        call set-metric with heart rate and time
      </button>
      <button
        type="button"
        data-testid="call-cadence"
        onClick={() => call({ metric: "cadence" })}
      >
        call set-metric with cadence
      </button>
      <button
        type="button"
        data-testid="call-pace"
        onClick={() => call({ metric: "pace" })}
      >
        call set-metric with pace
      </button>
      <button
        type="button"
        data-testid="call-power"
        onClick={() => call({ metric: "power" })}
      >
        call set-metric with power
      </button>
      <p data-testid="tool-said" data-error={reply?.isError || undefined}>
        {reply?.text}
      </p>
      <p data-testid="context-summary">{summary}</p>
    </>
  );
}

/** The helpers both model-driven stories read the page through. */
function modelDrivenProbes(canvasElement: HTMLElement) {
  const text = (testId: string) =>
    canvasElement.querySelector(`[data-testid='${testId}']`)?.textContent;
  return {
    said: () => text("tool-said"),
    summary: () => text("context-summary"),
    isError: () =>
      canvasElement
        .querySelector("[data-testid='tool-said']")
        ?.hasAttribute("data-error"),
    button: (testId: string) =>
      canvasElement.querySelector<HTMLButtonElement>(
        `[data-testid='${testId}']`,
      )!,
  };
}

/**
 * One side recorded no power: the model can pick any other shared metric and
 * either axis, keeps the axis when it names only a metric, and is refused,
 * by the labels the pills carry, a metric the pair does not share.
 */
export const ModelDrivenMetric = meta.story({
  tags: ["!autodocs"],
  args: { a: baselineRun, b: noPowerRun, compare: compareData },
  render: ({ a, b, compare }) => (
    <ModelDrivenCompare a={a} b={b} compare={compare} />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, summary, isError, button } = modelDrivenProbes(canvasElement);
    const pressed = (name: string) => canvas.getByRole("button", { name });

    await expect(pressed("Pace")).toHaveAttribute("aria-pressed", "true");
    await expect(pressed("Distance")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(button("call-heart-rate-by-time"));
    await waitFor(() => expect(said()).toBe("Comparing heart rate by time."));
    expect(isError()).toBe(false);
    await expect(pressed("Heart Rate")).toHaveAttribute("aria-pressed", "true");
    await expect(pressed("Pace")).toHaveAttribute("aria-pressed", "false");
    await expect(pressed("Time")).toHaveAttribute("aria-pressed", "true");
    // The model is told what the card now shows once the debounce fires.
    await waitFor(
      () => expect(summary()).toContain("Overlay: heart rate vs time."),
      { timeout: 3000 },
    );

    // A metric alone leaves the axis where it was.
    await userEvent.click(button("call-cadence"));
    await waitFor(() => expect(said()).toBe("Comparing cadence by time."));
    await expect(pressed("Cadence")).toHaveAttribute("aria-pressed", "true");
    await expect(pressed("Time")).toHaveAttribute("aria-pressed", "true");

    // Power was not recorded by both: refused, and the card stays put.
    await userEvent.click(button("call-power"));
    await waitFor(() =>
      expect(said()).toBe(
        "These activities did not both record power. Available metrics: pace, heart rate, cadence, altitude.",
      ),
    );
    expect(isError()).toBe(true);
    expect(canvas.queryByRole("button", { name: "Power" })).toBeNull();
    await expect(pressed("Cadence")).toHaveAttribute("aria-pressed", "true");
  },
});

/**
 * A run against a ride is a mixed pair, so the card calls pace "Speed": the
 * model's reply and the metrics it is offered read the same way.
 */
export const ModelDrivenMetricMixedSport = meta.story({
  tags: ["!autodocs"],
  args: { a: baselineRun, b: noPowerRide, compare: compareData },
  render: ({ a, b, compare }) => (
    <ModelDrivenCompare a={a} b={b} compare={compare} />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, summary, isError, button } = modelDrivenProbes(canvasElement);
    const pressed = (name: string) => canvas.getByRole("button", { name });

    await userEvent.click(button("call-heart-rate-by-time"));
    await waitFor(() => expect(said()).toBe("Comparing heart rate by time."));

    await userEvent.click(button("call-pace"));
    await waitFor(() => expect(said()).toBe("Comparing speed by time."));
    await expect(pressed("Speed")).toHaveAttribute("aria-pressed", "true");
    await waitFor(
      () => expect(summary()).toContain("Overlay: speed vs time."),
      { timeout: 3000 },
    );

    await userEvent.click(button("call-power"));
    await waitFor(() =>
      expect(said()).toBe(
        "These activities did not both record power. Available metrics: speed, heart rate, cadence, altitude.",
      ),
    );
    expect(isError()).toBe(true);
  },
});

/**
 * A side with no streams leaves nothing to overlay, so the model is told
 * there is nothing to choose instead of being handed an empty list.
 */
export const ModelDrivenMetricNoStreams = meta.story({
  tags: ["!autodocs"],
  args: { a: baselineRun, b: manualRun, compare: compareDataManualSide },
  render: ({ a, b, compare }) => (
    <ModelDrivenCompare a={a} b={b} compare={compare} />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, isError, button } = modelDrivenProbes(canvasElement);

    await userEvent.click(button("call-heart-rate-by-time"));
    await waitFor(() =>
      expect(said()).toBe(
        "These activities have no overlapping streams, so there is no metric or axis to choose.",
      ),
    );
    expect(isError()).toBe(true);
    await expect(
      canvas.getByText(
        "These activities have no overlapping streams to overlay.",
      ),
    ).toBeVisible();
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
