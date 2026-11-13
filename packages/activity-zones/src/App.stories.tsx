import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import {
  MobileCardShell,
  ViewToolRegistry,
  type ViewToolResult,
} from "@intervals-mcp/ui";
import { type useApp } from "@modelcontextprotocol/ext-apps/react";
import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import {
  emptyZonesData,
  hrAndPaceData,
  hrOnlyData,
  hrZoneMismatchData,
  hrZoneSet,
  mockZonesData,
  paceOnlyData,
  paceWithHrZoneWarningData,
  paceZoneSet,
} from "./__fixtures__/zones";
import { App } from "./App";
import { buildZonesSubtitle } from "./normalize";
import { type ActivityZonesData } from "./types";

const meta = preview.meta({ component: App });

export const Default = meta.story({
  args: { app: null, data: mockZonesData },
  play: async ({ canvas }) => {
    // The card opens with a title (ljcl/strava-mcp#247), and the subtitle names the set on
    // screen — the pill row only appears when both sets exist.
    await expect(canvas.getByText(mockZonesData.name)).toBeVisible();
    await expect(
      canvas.getByText(buildZonesSubtitle(mockZonesData, hrZoneSet)),
    ).toBeVisible();
  },
});

/**
 * Interaction test: switching the zone-set pill swaps the chart from the
 * 5-bucket heart-rate set to the 6-bucket power set — the bar count proves
 * the chart really re-rendered.
 */
export const SwitchToPower = meta.story({
  args: { app: null, data: mockZonesData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(barCount()).toBe(5));

    const powerPill = canvas.getByRole("button", { name: "Power" });
    await userEvent.click(powerPill);

    await expect(powerPill).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(barCount()).toBe(6));
  },
});

/**
 * A run with heart rate and pace zones: the "Pace" pill swaps the 5-bucket
 * heart rate chart for the 7-bucket pace chart, and the footer says the time
 * is grade-adjusted.
 */
export const SwitchToPace = meta.story({
  args: { app: null, data: hrAndPaceData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    await waitFor(() => expect(barCount()).toBe(5));

    const pacePill = canvas.getByRole("button", { name: "Pace" });
    await userEvent.click(pacePill);

    await expect(pacePill).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(barCount()).toBe(7));
    await expect(
      canvas.getByText(buildZonesSubtitle(hrAndPaceData, paceZoneSet)),
    ).toBeVisible();
    await expect(
      canvas.getByText("Zones: time by grade-adjusted pace (GAP)"),
    ).toBeVisible();
  },
});

/** A run without heart rate shows the Pace chart, not the empty state. */
export const PaceOnly = meta.story({
  args: { app: null, data: paceOnlyData },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(".recharts-bar-rectangle").length,
      ).toBe(7),
    );
    await expect(canvas.queryByText(/No zone data/)).toBeNull();
  },
});

export const PaceOnlyMobile = meta.story({
  args: { app: null, data: paceOnlyData, mode: "mobile" },
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

export const HeartRateOnly = meta.story({
  args: { app: null, data: hrOnlyData },
});

/**
 * No zone set to chart and no reason from the server. The card says so and
 * claims nothing about sensors, since the app cannot know about them.
 */
export const NoZoneData = meta.story({
  args: { app: null, data: emptyZonesData },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("No zone data to show for this activity."),
    ).toBeVisible();
    await expect(canvas.queryByText(/sensor/i)).toBeNull();
  },
});

/**
 * Heart rate zones dropped because the recorded bounds and zone times
 * disagree. The card gives the server's own reason, the same line the text
 * tools print, not a guess about a missing sensor.
 */
export const HeartRateZonesOmitted = meta.story({
  args: { app: null, data: hrZoneMismatchData },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(hrZoneMismatchData.hrZoneWarning!, { exact: false }),
    ).toBeVisible();
    await expect(canvas.queryByText(/sensor/i)).toBeNull();
  },
});

export const HeartRateZonesOmittedMobile = meta.story({
  args: { app: null, data: hrZoneMismatchData, mode: "mobile" },
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
 * Heart rate zones dropped (bounds and zone times disagree) on a run that
 * still has pace zones (#396): the card charts pace and gives the server's
 * reason beside it, the line the text tools print, so it never reads as a
 * run without heart rate.
 */
export const PaceWithHeartRateZonesOmitted = meta.story({
  args: { app: null, data: paceWithHrZoneWarningData },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(".recharts-bar-rectangle").length,
      ).toBe(7),
    );
    await expect(
      canvas.getByText(paceWithHrZoneWarningData.hrZoneWarning!),
    ).toBeVisible();
    await expect(canvas.queryByText(/No zone data/)).toBeNull();
  },
});

export const PaceWithHeartRateZonesOmittedMobile =
  PaceWithHeartRateZonesOmitted.extend({
    args: { mode: "mobile" },
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

type HostApp = ReturnType<typeof useApp>["app"];

/**
 * The card driven the way a host drives it: `set-zone-type` through a real
 * registry, buttons standing in for the model's calls, and the reply and the
 * synced context summary printed under the card.
 */
function ModelDrivenZones({ data }: { data: ActivityZonesData }) {
  // Stable across renders: a registry rebuilt each render would have the
  // handler installed on an instance the buttons no longer hold.
  const [registry] = useState(() => new ViewToolRegistry());
  const [reply, setReply] = useState<ViewToolResult | null>(null);
  const [summary, setSummary] = useState("");
  const [app] = useState(
    () =>
      ({
        getHostCapabilities: () => ({ updateModelContext: {} }),
        updateModelContext: async ({
          content,
        }: {
          content: Array<{ type: string; text?: string }>;
        }) => {
          setSummary(content.map((c) => c.text ?? "").join(""));
        },
      }) as unknown as HostApp,
  );
  const call = (args: Record<string, unknown>) => {
    void registry.invoke("set-zone-type", args).then(setReply);
  };
  return (
    <>
      <App app={app} data={data} viewToolRegistry={registry} />
      <button
        type="button"
        data-testid="call-pace"
        onClick={() => call({ type: "pace" })}
      >
        call set-zone-type with pace
      </button>
      <button
        type="button"
        data-testid="call-heartrate"
        onClick={() => call({ type: "heartrate" })}
      >
        call set-zone-type with heart rate
      </button>
      <p data-testid="tool-said" data-error={reply?.isError || undefined}>
        {reply?.text}
      </p>
      <p data-testid="context-summary">{summary}</p>
    </>
  );
}

/** The helpers the model-driven stories read the page through. */
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
    bars: () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length,
  };
}

/**
 * The model switches the card to pace and back (#397). The pill follows, the
 * chart redraws, and the context names the set on screen, including one the
 * athlete picked with the pills.
 */
export const ModelDrivenZoneType = meta.story({
  tags: ["!autodocs"],
  args: { app: null, data: hrAndPaceData },
  render: ({ data }) => <ModelDrivenZones data={data} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, summary, isError, button, bars } =
      modelDrivenProbes(canvasElement);
    const pill = (name: string) => canvas.getByRole("button", { name });

    await waitFor(() => expect(bars()).toBe(5));
    await waitFor(
      () => expect(summary()).toContain("On screen: Heart rate zones."),
      { timeout: 3000 },
    );

    await userEvent.click(button("call-pace"));
    await waitFor(() => expect(said()).toBe("Showing Pace zones (GAP)."));
    expect(isError()).toBe(false);
    await expect(pill("Pace")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(bars()).toBe(7));
    await waitFor(
      () => expect(summary()).toContain("On screen: Pace zones (GAP)."),
      { timeout: 3000 },
    );

    // The athlete's own switch reaches the model too.
    await userEvent.click(pill("Heart rate"));
    await waitFor(() => expect(bars()).toBe(5));
    await waitFor(
      () => expect(summary()).toContain("On screen: Heart rate zones."),
      { timeout: 3000 },
    );
  },
});

/**
 * Heart rate is refused on a card whose heart rate zones the server dropped:
 * the reply gives the server's reason and the set the model can send, and
 * the card stays on pace.
 */
export const ModelDrivenZoneTypeRefused = meta.story({
  tags: ["!autodocs"],
  args: { app: null, data: paceWithHrZoneWarningData },
  render: ({ data }) => <ModelDrivenZones data={data} />,
  play: async ({ canvasElement, userEvent }) => {
    const { said, isError, button, bars } = modelDrivenProbes(canvasElement);
    await waitFor(() => expect(bars()).toBe(7));

    await userEvent.click(button("call-heartrate"));
    await waitFor(() =>
      expect(said()).toBe(
        `This activity has no heart rate zones. ${paceWithHrZoneWarningData.hrZoneWarning} Available: pace. Nothing was changed.`,
      ),
    );
    expect(isError()).toBe(true);
    await expect(bars()).toBe(7);
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockZonesData },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: { app: null, data: mockZonesData, mode: "mobile" },
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
