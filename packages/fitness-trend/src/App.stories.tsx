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
  mockBaseArgs,
  mockFitnessTrendData,
  mockNoLoadData,
  mockRestProjectionData,
  mockRunOnlyFitnessTrendData,
} from "./__fixtures__/trend";
import { App } from "./App";
import { buildTrendSubtitle } from "./normalize";

const meta = preview.meta({ component: App });

/**
 * A fake host app whose `callServerTool` answers `get-fitness-trend-data`
 * from the two fixtures below, keyed on `runOnly`. Same shape the real host
 * returns, so the toggle's `useServerToolFetcher` fetch actually resolves in
 * Storybook instead of hanging on a null app.
 */
const toggleApp = {
  callServerTool: async ({
    arguments: args,
  }: {
    arguments?: Record<string, unknown>;
  }) => {
    const data = args?.runOnly
      ? mockRunOnlyFitnessTrendData
      : mockFitnessTrendData;
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
  getHostCapabilities: () => undefined,
} as unknown as ReturnType<typeof useApp>["app"];

type CallServerTool = NonNullable<
  ReturnType<typeof useApp>["app"]
>["callServerTool"];

/**
 * `toggleApp`, except its first call rejects the way a host timeout does.
 * The story resets it before each run, so the switch always fails first and
 * only the retry gets through.
 */
let flakyCalls = 0;
const flakyApp = {
  callServerTool: async (...call: Parameters<CallServerTool>) => {
    flakyCalls += 1;
    if (flakyCalls === 1) {
      throw new Error("MCP error -32001: Request timed out");
    }
    return toggleApp!.callServerTool(...call);
  },
  getHostCapabilities: () => undefined,
} as unknown as ReturnType<typeof useApp>["app"];

/**
 * A fake host app whose call is still running: the server has sent one
 * progress message and no answer yet.
 */
const slowApp = {
  callServerTool: (
    _params: Parameters<CallServerTool>[0],
    options?: Parameters<CallServerTool>[1],
  ) => {
    options?.onprogress?.({ progress: 1, message: "Listed 200 activities" });
    return new Promise(() => {});
  },
  getHostCapabilities: () => undefined,
} as unknown as ReturnType<typeof useApp>["app"];

/**
 * Ninety days of build ending deep in fatigue, with a three-week taper solved
 * to land on form +12 on race day — the dashed continuation and the plan list
 * are two views of one server-side solve.
 */
export const WholeBody = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    // The card opens with a title (ljcl/strava-mcp#247): scrolled back in a transcript, a
    // bare chart cannot say which window it belongs to.
    await expect(canvas.getByText("Fitness trend")).toBeVisible();
    await expect(
      canvas.getByText(buildTrendSubtitle(mockFitnessTrendData)),
    ).toBeVisible();
    // The plan reads in words as well as curves.
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
    await expect(canvas.getByText("Week 1")).toBeVisible();
    // Scope toggle: whole body is active, and it says where the numbers came from.
    await expect(
      canvas.getByRole("button", { name: "Whole body" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(/From intervals.icu/)).toBeVisible();
  },
});

/**
 * `runOnly: true` from the start (the tool call's own default): the toggle
 * opens on "Runs only", and the computed-locally disclaimer is visible.
 */
export const RunsOnly = meta.story({
  args: {
    app: null,
    data: mockRunOnlyFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: true,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "Runs only" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(/Computed locally/)).toBeVisible();
    // Run-only has no taper solved in this fixture, only a rest projection.
    await expect(canvas.queryByText(/Plan to/)).toBeNull();
  },
});

/**
 * Switching scope: clicking "Runs only" fetches and caches the other scope
 * through the fake host app above; switching back to "Whole body" is instant
 * (the original mount data, never re-fetched) and still shows the taper plan.
 */
export const Switching = meta.story({
  args: {
    app: toggleApp,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/From intervals.icu/)).toBeVisible();
    await expect(canvas.getByText(/Plan to/)).toBeVisible();

    const runsOnly = canvas.getByRole("button", { name: "Runs only" });
    runsOnly.click();

    await waitFor(() =>
      expect(canvas.getByText(/Computed locally/)).toBeVisible(),
    );
    await expect(canvas.queryByText(/Plan to/)).toBeNull();

    // Switching back to whole body is instant: the mount data is cached,
    // not re-fetched, and the taper plan reappears.
    const wholeBody = canvas.getByRole("button", { name: "Whole body" });
    wholeBody.click();
    await waitFor(() =>
      expect(canvas.getByText(/From intervals.icu/)).toBeVisible(),
    );
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
  },
});

/**
 * The other scope fails to load (#55). The card shows the error and a retry
 * instead of an endless skeleton, and the retry calls the tool again.
 */
export const SwitchingFails = meta.story({
  args: {
    app: flakyApp,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  beforeEach: () => {
    flakyCalls = 0;
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Runs only" }));

    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(/Request timed out/),
    );
    await expect(canvas.queryByRole("status")).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(canvas.getByText(/Computed locally/)).toBeVisible(),
    );
    await expect(flakyCalls).toBe(2);
  },
});

export const SwitchingFailsMobile = SwitchingFails.extend({
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

/**
 * The other scope is slow to load. The skeleton shows the server's latest
 * progress line, so the wait says what is happening.
 */
export const SwitchingSlow = meta.story({
  args: {
    app: slowApp,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Runs only" }));

    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent(
        "Listed 200 activities",
      ),
    );
  },
});

/**
 * `toggleApp` that also reports what the model is told, so the story can read
 * the context summary the way a host would.
 */
function ModelDrivenFitness() {
  // Stable across renders: a registry rebuilt each render would have the
  // handler installed on an instance the buttons no longer hold.
  const [registry] = useState(() => new ViewToolRegistry());
  const [reply, setReply] = useState<ViewToolResult | null>(null);
  const [summary, setSummary] = useState("");
  const [app] = useState(
    () =>
      ({
        callServerTool: (...call: Parameters<CallServerTool>) =>
          toggleApp!.callServerTool(...call),
        getHostCapabilities: () => ({ updateModelContext: {} }),
        updateModelContext: async ({
          content,
        }: {
          content: Array<{ type: string; text?: string }>;
        }) => {
          setSummary(content.map((c) => c.text ?? "").join(""));
        },
      }) as unknown as ReturnType<typeof useApp>["app"],
  );
  const call = (args: Record<string, unknown>) => {
    void registry.invoke("set-scope", args).then(setReply);
  };
  const buttons: Array<[string, string, Record<string, unknown>]> = [
    [
      "call-runs-without-fatigue",
      "call set-scope with runs only and fatigue hidden",
      { scope: "runOnly", hide: ["fatigue"] },
    ],
    [
      "call-form-both-ways",
      "call set-scope showing and hiding form",
      { show: ["form"], hide: ["form"] },
    ],
    [
      "call-whole-body-with-fatigue",
      "call set-scope with whole body and fatigue shown",
      { scope: "wholeBody", show: ["fatigue"] },
    ],
    ["call-hide-plan", "call set-scope hiding the plan", { hide: ["plan"] }],
  ];
  return (
    <>
      <App
        app={app}
        data={mockFitnessTrendData}
        baseArgs={mockBaseArgs}
        initialRunOnly={false}
        viewToolRegistry={registry}
      />
      {buttons.map(([testId, label, args]) => (
        <button
          key={testId}
          type="button"
          data-testid={testId}
          onClick={() => call(args)}
        >
          {label}
        </button>
      ))}
      <p data-testid="tool-said" data-error={reply?.isError || undefined}>
        {reply?.text}
      </p>
      <p data-testid="context-summary">{summary}</p>
    </>
  );
}

/**
 * The model switches the scope and hides a series. Asserted through what the
 * athlete would see (the scope pill, the legend, the drawn lines, the plan
 * list) and what the model is told (the reply and the context summary). The
 * scope switch goes through the same keyed fetch as the pill, answered by
 * `toggleApp`.
 */
export const ModelDrivenScope = meta.story({
  tags: ["!autodocs"],
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  render: () => <ModelDrivenFitness />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = (testId: string) =>
      canvasElement.querySelector(`[data-testid='${testId}']`)?.textContent;
    const said = () => text("tool-said");
    const isError = () =>
      canvasElement
        .querySelector("[data-testid='tool-said']")
        ?.hasAttribute("data-error");
    const click = (testId: string) =>
      userEvent.click(
        canvasElement.querySelector<HTMLButtonElement>(
          `[data-testid='${testId}']`,
        )!,
      );
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    const pill = (name: string) => canvas.getByRole("button", { name });
    const fatigue = () =>
      canvas.getByRole("button", { name: "Toggle Fatigue" });

    await expect(pill("Whole body")).toHaveAttribute("aria-pressed", "true");
    await expect(fatigue()).toHaveAttribute("aria-pressed", "true");
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(curveCount()).toBe(5));

    // Runs only with fatigue hidden: the pill follows, the other scope is
    // fetched by the keyed store, and the fatigue line and its dashed
    // continuation leave the chart.
    await click("call-runs-without-fatigue");
    await waitFor(() =>
      expect(said()).toBe("Showing runs only. Hidden: fatigue."),
    );
    expect(isError()).toBe(false);
    await expect(pill("Runs only")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(canvas.getByText(/Computed locally/)).toBeVisible(),
    );
    await expect(fatigue()).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(3));
    // The model is told what the card now shows once the debounce fires.
    await waitFor(
      () => {
        expect(text("context-summary")).toContain(
          "Scope: runs only, computed locally.",
        );
        expect(text("context-summary")).toContain("Hidden series: fatigue.");
      },
      { timeout: 3000 },
    );

    // A series both shown and hidden is refused by name and changes nothing.
    await click("call-form-both-ways");
    await waitFor(() => expect(said()).toBe("Cannot both show and hide form."));
    expect(isError()).toBe(true);
    await expect(
      canvas.getByRole("button", { name: "Toggle Form" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(pill("Runs only")).toHaveAttribute("aria-pressed", "true");

    // Back to whole body with fatigue shown: the mount data is held, so the
    // switch is instant and the taper plan is back.
    await click("call-whole-body-with-fatigue");
    await waitFor(() =>
      expect(said()).toBe("Showing whole body. Nothing hidden."),
    );
    await expect(pill("Whole body")).toHaveAttribute("aria-pressed", "true");
    await expect(fatigue()).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(/From intervals.icu/)).toBeVisible();
    await waitFor(() => expect(curveCount()).toBe(5));

    // The plan answers to the name it carries on screen, and takes its week
    // list with it.
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
    await click("call-hide-plan");
    await waitFor(() =>
      expect(said()).toBe("Showing whole body. Hidden: plan (taper plan)."),
    );
    await waitFor(() => expect(canvas.queryByText(/Plan to/)).toBeNull());
  },
});

/** No target date: the forward half is the zero-load rest projection. */
export const RestProjection = meta.story({
  args: {
    app: null,
    data: mockRestProjectionData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "Toggle Rest projection" }),
    ).toBeVisible();
    await expect(canvas.queryByText(/Plan to/)).toBeNull();
  },
});

/**
 * Interaction test: hiding Form drops the TSB line and its right-hand axis,
 * leaving the fitness area and fatigue line. Recharts removes a hidden Line's
 * path from the SVG, so the curve count proves it really left the chart.
 */
export const LegendToggleHidesForm = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const curveCount = () =>
      canvasElement.querySelectorAll("path.recharts-line-curve").length;
    const areaCount = () =>
      canvasElement.querySelectorAll("path.recharts-area-area").length;
    // ResponsiveContainer needs a resize tick before the chart mounts. Five
    // lines: fatigue, form, and the three dashed continuations — fitness is
    // an Area when recorded but a Line when planned.
    await waitFor(() => expect(curveCount()).toBe(5));

    const formToggle = canvas.getByRole("button", { name: "Toggle Form" });
    await expect(formToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(formToggle);

    await expect(formToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(3));
    await expect(areaCount()).toBeGreaterThan(0);
  },
});

/**
 * Hiding the plan takes the dashed curves and the week list with it — the
 * list is the plan's numbers, so leaving it behind would contradict the chart.
 */
export const PlanHidden = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText(/Plan to/)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle Taper plan" }),
    );
    await waitFor(() => expect(canvas.queryByText(/Plan to/)).toBeNull());
  },
});

/**
 * Fatigue and ramp bands overlap in this window, so each kind gets its own
 * legend toggle; hiding one leaves the other shaded.
 */
export const BandKindsToggleIndependently = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const shadeCount = () =>
      canvasElement.querySelectorAll(".recharts-reference-area").length;
    await waitFor(() =>
      expect(shadeCount()).toBe(mockFitnessTrendData.bands.length),
    );

    const fatigue = canvas.getByRole("button", {
      name: /Toggle Deep fatigue/,
    });
    await userEvent.click(fatigue);

    const rampBands = mockFitnessTrendData.bands.filter(
      (band) => band.kind === "steep-ramp",
    ).length;
    await waitFor(() => expect(shadeCount()).toBe(rampBands));
    await expect(
      canvas.getByRole("button", { name: /Toggle Steep ramp/ }),
    ).toHaveAttribute("aria-pressed", "true");
  },
});

/** No training load, CTL, or ATL recorded anywhere in the window. */
export const NoRecordedLoad = meta.story({
  args: {
    app: null,
    data: mockNoLoadData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(/No training load recorded in this window/),
    ).toBeVisible();
  },
});

export const Dark = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
  },
  globals: darkGlobals,
});

export const Mobile = meta.story({
  args: {
    app: null,
    data: mockFitnessTrendData,
    baseArgs: mockBaseArgs,
    initialRunOnly: false,
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
