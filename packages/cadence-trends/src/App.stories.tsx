import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell, ViewToolRegistry } from "@intervals-mcp/ui";
import { type App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import { rawStreamsPayload } from "./__fixtures__/overlay-streams";
import { mockRuns } from "./__fixtures__/runs";
import { App } from "./App";
import { buildCadenceSubtitle } from "./normalize";
import { type CadenceTrendData } from "./types";

const mockData: CadenceTrendData = { weeks: 6, activities: mockRuns };

const meta = preview.meta({ component: App });

export const Default = meta.story({
  args: { app: null, data: mockData },
  play: async ({ canvas }) => {
    // The card opens with a title (ljcl/strava-mcp#247): scrolled back in a transcript, a
    // bare chart cannot say which runs or window it belongs to.
    await expect(canvas.getByText("Cadence trends")).toBeVisible();
    await expect(
      canvas.getByText(buildCadenceSubtitle(mockRuns.length, mockData.weeks)),
    ).toBeVisible();
  },
});

/**
 * Keyboard-accessible run selection (ljcl/strava-mcp#169). Previously the only way to build an
 * overlay comparison was clicking Recharts dots, which carry no tabindex or key
 * handling. The run picker below the Trend/Scatter charts lets a keyboard user
 * select and deselect runs: focus a chip, activate it, and its `aria-pressed`
 * flips while the selection bar and count update. A second activation deselects.
 */
export const KeyboardRunSelection = meta.story({
  args: { app: null, data: mockData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const group = canvas.getByRole("group", { name: /compare runs/i });
    const chip = within(group).getByRole("button", {
      name: /Tempo Intervals/,
    });
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    // Select via keyboard: focus the chip and press Enter.
    chip.focus();
    await expect(chip).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(group).toHaveAccessibleName(/1 of 4 selected/);
    // The run now appears in the selection bar with a remove control.
    await expect(
      canvas.getByRole("button", { name: "Remove Tempo Intervals" }),
    ).toBeInTheDocument();

    // Deselect via keyboard: Space toggles it back off.
    await userEvent.keyboard(" ");
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(group).toHaveAccessibleName(/0 of 4 selected/);
    await expect(
      within(canvasElement).queryByRole("button", {
        name: "Remove Tempo Intervals",
      }),
    ).toBeNull();
  },
});

/**
 * #65, end to end through the keyed fetcher: the server answers a stream-less
 * run with a `noStreams` payload, not an error. The overlay names that run
 * and draws the other, and offers no retry.
 */
const streamlessApp = {
  getHostCapabilities: () => undefined,
  callServerTool: async ({
    arguments: args,
  }: {
    arguments?: Record<string, unknown>;
  }) => {
    const id = String(args?.activity_id);
    const payload =
      id === "i10013"
        ? {
            activityId: id,
            activityType: "Run",
            name: "Intervals 5x1k",
            streams: { time: [] },
            laps: [],
            noStreams: true,
          }
        : {
            activityId: id,
            activityType: "Run",
            name: "Tempo Intervals",
            streams: {
              time: [0, 60, 120, 180, 240],
              distance: [0, 220, 440, 660, 880],
              cadence: [84, 86, 87, 86, 85],
            },
          };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
} as unknown as McpApp;

export const OverlayRunWithoutStreams = meta.story({
  args: { app: streamlessApp, data: mockData },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const group = canvas.getByRole("group", { name: /compare runs/i });
    await userEvent.click(
      within(group).getByRole("button", { name: /Tempo Intervals/ }),
    );
    await userEvent.click(
      within(group).getByRole("button", { name: /Intervals 5x1k/ }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Overlay" }));

    await expect(
      await canvas.findByText("No recorded streams for Intervals 5x1k."),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(1),
    );
    expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
  },
});

/**
 * Host-driven view tool (#68): the model calls `set-view` and the card
 * switches view, replaces the overlay selection and picks the overlay axis.
 * Asserted through what the athlete would see (the active pill, the legend,
 * the drawn lines) and what the model is told (the reply and the context
 * summary). The fake app answers the stream fetches from `overlay-streams.ts`,
 * and Threshold Run (i10006) as a run with no recorded streams.
 *
 * The reply is claimed only for what is drawn: it goes out before a new run's
 * fetch starts, so it says the run is still loading; a stream-less run, and
 * one the legend hides, are named as such.
 */
function ModelDrivenCadence() {
  // Stable across renders: a registry rebuilt each render would have the
  // handler installed on an instance the button no longer holds.
  const [registry] = useState(() => new ViewToolRegistry());
  const [said, setSaid] = useState("");
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
        callServerTool: async ({
          arguments: args,
        }: {
          arguments?: Record<string, unknown>;
        }) => {
          const id = String(args?.activity_id);
          const payload =
            id === "i10006"
              ? {
                  activityId: id,
                  activityType: "Run",
                  name: "Threshold Run",
                  streams: { time: [] },
                  laps: [],
                  noStreams: true,
                }
              : rawStreamsPayload(id);
          return { content: [{ type: "text", text: JSON.stringify(payload) }] };
        },
      }) as unknown as McpApp,
  );
  const call = (args: Record<string, unknown>) => {
    void registry.invoke("set-view", args).then((r) => setSaid(r.text));
  };
  return (
    <>
      <App app={app} data={mockData} viewToolRegistry={registry} />
      <button
        type="button"
        data-testid="call-overlay-runs"
        onClick={() => call({ runIds: ["i10013", "i10003"] })}
      >
        call set-view with runs
      </button>
      <button
        type="button"
        data-testid="call-time-axis"
        onClick={() => call({ xAxis: "time" })}
      >
        call set-view with axis
      </button>
      <button
        type="button"
        data-testid="call-distance-axis"
        onClick={() => call({ xAxis: "distance" })}
      >
        call set-view with the distance axis
      </button>
      <button
        type="button"
        data-testid="call-streamless-run"
        onClick={() => call({ runIds: ["i10006", "i10003"] })}
      >
        call set-view with a run that has no streams
      </button>
      <button
        type="button"
        data-testid="call-unknown-run"
        onClick={() => call({ runIds: ["i99999"] })}
      >
        call set-view with an unknown run
      </button>
      <p data-testid="tool-said">{said}</p>
      <p data-testid="context-summary">{summary}</p>
    </>
  );
}

export const ModelDrivenView = meta.story({
  args: { app: null, data: mockData },
  render: () => <ModelDrivenCadence />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const said = () =>
      canvasElement.querySelector("[data-testid='tool-said']")?.textContent;
    const click = (testId: string) =>
      userEvent.click(
        canvasElement.querySelector<HTMLButtonElement>(
          `[data-testid='${testId}']`,
        )!,
      );

    await expect(canvas.getByRole("button", { name: "Trend" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const summary = () =>
      canvasElement.querySelector("[data-testid='context-summary']")
        ?.textContent;

    // Runs without a view: the selection is replaced, in the order given, and
    // the card moves to the overlay to show them. Nothing is drawn when the
    // reply goes out, so it claims nothing; the summary follows the lines.
    await click("call-overlay-runs");
    await waitFor(() =>
      expect(said()).toBe(
        "Showing the overlay by distance, with no run drawn. Intervals 5x1k and Tempo Intervals are still loading.",
      ),
    );
    await expect(
      canvas.getByRole("button", { name: "Overlay" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      await canvas.findByRole("button", { name: /Toggle Intervals 5x1k/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /Toggle Tempo Intervals/ }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(2),
    );
    await waitFor(() =>
      expect(summary()).toContain(
        "Comparing: Intervals 5x1k (178 spm), Tempo Intervals (172 spm).",
      ),
    );

    // The axis alone: the pills follow the tool, and the model's summary
    // carries the axis once the debounce has fired.
    await click("call-time-axis");
    await waitFor(() =>
      expect(said()).toBe(
        "Showing the overlay of Intervals 5x1k and Tempo Intervals by time.",
      ),
    );
    await expect(canvas.getByRole("button", { name: "min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(summary()).toContain("Overlay x-axis: time."));

    // A run the athlete hid in the legend is named as hidden, not shown...
    await userEvent.click(
      canvas.getByRole("button", { name: /Toggle Tempo Intervals/ }),
    );
    await click("call-distance-axis");
    await waitFor(() =>
      expect(said()).toBe(
        "Showing the overlay of Intervals 5x1k by distance. Tempo Intervals is hidden in the legend.",
      ),
    );
    await waitFor(() =>
      expect(summary()).toContain("Hidden in the legend: Tempo Intervals."),
    );

    // ...until the model selects it again, which shows it: both runs are
    // loaded already, so both are drawn as the reply goes out.
    await click("call-overlay-runs");
    await waitFor(() =>
      expect(said()).toBe(
        "Showing the overlay of Intervals 5x1k and Tempo Intervals by distance.",
      ),
    );
    await expect(
      canvas.getByRole("button", { name: /Toggle Tempo Intervals/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll("path.recharts-line-curve").length,
      ).toBe(2),
    );

    // A newly selected run is still loading when the reply goes out; once it
    // arrives with no streams, the summary and the next reply say so.
    await click("call-streamless-run");
    await waitFor(() =>
      expect(said()).toBe(
        "Showing the overlay of Tempo Intervals by distance. Threshold Run is still loading.",
      ),
    );
    await expect(
      await canvas.findByText("No recorded streams for Threshold Run."),
    ).toBeVisible();
    await waitFor(() =>
      expect(summary()).toContain(
        "Comparing: Tempo Intervals (172 spm). No recorded streams: Threshold Run.",
      ),
    );
    await click("call-distance-axis");
    await waitFor(() =>
      expect(said()).toBe(
        "Showing the overlay of Tempo Intervals by distance. Threshold Run has no recorded streams.",
      ),
    );

    // An id that is not in the chart is refused by name and changes nothing.
    await click("call-unknown-run");
    await waitFor(() =>
      expect(said()).toBe(
        'Not runs in this chart: i99999. Run ids come from list-activities (for example "i189807578") and must fall within the chart\'s weeks. Nothing was changed.',
      ),
    );
    await expect(
      canvas.getByRole("button", { name: /Toggle Tempo Intervals/ }),
    ).toBeVisible();
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockData },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: { app: null, data: mockData, mode: "mobile" },
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
