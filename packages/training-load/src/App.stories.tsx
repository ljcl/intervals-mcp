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
  mockPastTrainingLoadData,
  mockRunOnlyTrainingLoadData,
  mockTrainingLoadData,
} from "./__fixtures__/weeks";
import { App } from "./App";
import {
  buildLoadSubtitle,
  buildScopeNote,
  type TrainingLoadDataArgs,
} from "./normalize";
import { type TrainingLoadData } from "./types";

const meta = preview.meta({ component: App });

/** What `buildDataArgs` gives a call with no arguments. */
const wholeBodyArgs: TrainingLoadDataArgs = { days: 84, runOnly: false };
const runOnlyArgs: TrainingLoadDataArgs = { days: 84, runOnly: true };
/** A call with a past `newest` (#80). */
const pastArgs: TrainingLoadDataArgs = {
  days: 84,
  runOnly: false,
  newest: "2026-06-24",
};

/** The two scope notes, which tell the scopes apart on screen. */
const wholeBodyNote = buildScopeNote(mockTrainingLoadData);
const runOnlyNote = buildScopeNote(mockRunOnlyTrainingLoadData);

/** No run in the window: the chart is an EmptyState with no legend. */
const noRunsData: TrainingLoadData = {
  ...mockTrainingLoadData,
  weeks: [],
  totals: { runs: 0, distanceKm: 0, timeHours: 0, elevationM: 0, load: 0 },
};

type HostApp = ReturnType<typeof useApp>["app"];
type CallServerTool = NonNullable<HostApp>["callServerTool"];

/** A fake host whose `get-training-load-data` answers from `pick(runOnly)`. */
const answering = (pick: (runOnly: boolean) => TrainingLoadData): HostApp =>
  ({
    callServerTool: async ({
      arguments: args,
    }: {
      arguments?: Record<string, unknown>;
    }) => ({
      content: [
        { type: "text", text: JSON.stringify(pick(Boolean(args?.runOnly))) },
      ],
    }),
    getHostCapabilities: () => undefined,
  }) as unknown as HostApp;

/**
 * A fake host app whose `callServerTool` answers `get-training-load-data`
 * from the two fixtures, keyed on `runOnly`. Same shape the real host
 * returns, so the pills' `useServerToolFetcher` fetch actually resolves in
 * Storybook instead of hanging on a null app.
 */
const toggleApp = answering((runOnly) =>
  runOnly ? mockRunOnlyTrainingLoadData : mockTrainingLoadData,
);

/** Every call the toggle host has answered, to prove a flip back is cached. */
let toggleCalls: Array<Record<string, unknown> | undefined> = [];
const countingApp = {
  callServerTool: async (...call: Parameters<CallServerTool>) => {
    toggleCalls.push(call[0].arguments);
    return toggleApp!.callServerTool(...call);
  },
  getHostCapabilities: () => undefined,
} as unknown as HostApp;

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
} as unknown as HostApp;

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
} as unknown as HostApp;

const mobile = {
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" as const },
  decorators: [
    (StoryFn: () => React.ReactNode) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
};

/** Whole-body load (runs and rides), CTL/ATL read from intervals.icu. */
export const WholeBody = meta.story({
  args: { app: null, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The card opens with a title (ljcl/strava-mcp#247): scrolled back in a transcript, a
    // bare chart cannot say which period it belongs to.
    await expect(canvas.getByText("Training load")).toBeVisible();
    await expect(
      canvas.getByText(buildLoadSubtitle(mockTrainingLoadData)),
    ).toBeVisible();
    // The pills open on the scope the data was summed over, and the scope
    // note says what the load and the fitness tiles add up.
    await expect(
      canvas.getByRole("button", { name: "Whole body" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(wholeBodyNote)).toBeVisible();

    // The legend's Load toggle removes the load line. Recharts drops a hidden
    // Line's path from the SVG, so the stroke-matched curve count proves the
    // line really left the chart while the trend line stayed.
    const curves = (stroke: string) =>
      canvasElement.querySelectorAll(
        `path.recharts-line-curve[stroke="${stroke}"]`,
      ).length;
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(1));

    const loadToggle = canvas.getByRole("button", { name: "Toggle Load" });
    await expect(loadToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(loadToggle);

    await expect(loadToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(0));
    await expect(curves("var(--chart-cadence)")).toBe(1);
  },
});

/** Run-only load, CTL/ATL computed locally from the runs. */
export const RunOnly = meta.story({
  args: {
    app: null,
    data: mockRunOnlyTrainingLoadData,
    dataArgs: runOnlyArgs,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "Runs only" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(runOnlyNote)).toBeVisible();
  },
});

/**
 * Switching scope both ways: "Runs only" fetches the other scope through the
 * fake host, with the mount's `days` and `runOnly` flipped; back to "Whole
 * body" is the mount data, never re-fetched; and "Runs only" again is the
 * cached fetch. Each scope's tiles and note follow the pill.
 */
export const Switching = meta.story({
  args: {
    app: countingApp,
    data: mockTrainingLoadData,
    dataArgs: wholeBodyArgs,
  },
  beforeEach: () => {
    toggleCalls = [];
  },
  play: async ({ canvas, userEvent }) => {
    const pill = (name: string) => canvas.getByRole("button", { name });
    await expect(canvas.getByText(wholeBodyNote)).toBeVisible();

    await userEvent.click(pill("Runs only"));
    await waitFor(() => expect(canvas.getByText(runOnlyNote)).toBeVisible());
    await expect(pill("Runs only")).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.queryByText(wholeBodyNote)).toBeNull();
    await expect(toggleCalls).toEqual([{ days: 84, runOnly: true }]);

    await userEvent.click(pill("Whole body"));
    await waitFor(() => expect(canvas.getByText(wholeBodyNote)).toBeVisible());
    await expect(canvas.queryByText(runOnlyNote)).toBeNull();

    await userEvent.click(pill("Runs only"));
    await waitFor(() => expect(canvas.getByText(runOnlyNote)).toBeVisible());
    await expect(toggleCalls).toHaveLength(1);
  },
});

/** Opened on runs only: "Whole body" is the scope fetched on demand. */
export const SwitchingFromRunOnly = meta.story({
  args: {
    app: toggleApp,
    data: mockRunOnlyTrainingLoadData,
    dataArgs: runOnlyArgs,
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText(runOnlyNote)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Whole body" }));
    await waitFor(() => expect(canvas.getByText(wholeBodyNote)).toBeVisible());
    await expect(canvas.queryByText(runOnlyNote)).toBeNull();
  },
});

export const SwitchingMobile = Switching.extend({
  args: { mode: "mobile" },
  ...mobile,
});

/**
 * The other scope fails to load. The card shows the error and a retry in
 * place of the totals and chart, never the first scope's numbers under the
 * second's pill, and the retry calls the tool again.
 */
export const SwitchingFails = meta.story({
  args: { app: flakyApp, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  beforeEach: () => {
    flakyCalls = 0;
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Runs only" }));

    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(/Request timed out/),
    );
    await expect(canvas.queryByRole("status")).toBeNull();
    await expect(canvas.queryByText(wholeBodyNote)).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Toggle Load" }),
    ).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(canvas.getByText(runOnlyNote)).toBeVisible());
    await expect(flakyCalls).toBe(2);
  },
});

export const SwitchingFailsMobile = SwitchingFails.extend({
  args: { mode: "mobile" },
  ...mobile,
});

/**
 * The other scope is slow to load. The skeleton stands in for the totals and
 * chart and shows the server's latest progress line.
 */
export const SwitchingSlow = meta.story({
  args: { app: slowApp, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Runs only" }));

    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent(
        "Listed 200 activities",
      ),
    );
    await expect(canvas.queryByText(wholeBodyNote)).toBeNull();
    // The subtitle falls back to the requested window rather than keep the
    // other scope's weeks.
    await expect(canvas.getByText("Last 84 days")).toBeVisible();
  },
});

interface ToolCall {
  id: string;
  label: string;
  args: Record<string, unknown>;
}

/**
 * The card driven the way a host drives it: a `set-scope` button per call, the
 * latest reply, and the context summary the model is told. `host` answers the
 * data fetches, so each story picks how the other scope loads.
 */
function ModelDrivenLoad({
  host,
  data,
  calls,
}: {
  host: HostApp;
  data: TrainingLoadData;
  calls: ToolCall[];
}) {
  // Stable across renders: a registry rebuilt each render would have the
  // handler installed on an instance the buttons no longer hold.
  const [registry] = useState(() => new ViewToolRegistry());
  const [reply, setReply] = useState<ViewToolResult | null>(null);
  const [summary, setSummary] = useState("");
  const [app] = useState(
    () =>
      ({
        callServerTool: (...call: Parameters<CallServerTool>) =>
          host!.callServerTool(...call),
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
  return (
    <>
      <App
        app={app}
        data={data}
        dataArgs={wholeBodyArgs}
        viewToolRegistry={registry}
      />
      {calls.map(({ id, label, args }) => (
        <button
          key={id}
          type="button"
          data-testid={id}
          onClick={() => void registry.invoke("set-scope", args).then(setReply)}
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

/** The helpers every model-driven story reads the page through. */
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
    curves: (stroke: string) =>
      canvasElement.querySelectorAll(
        `path.recharts-line-curve[stroke="${stroke}"]`,
      ).length,
  };
}

const runsOnlyWithoutLoad: ToolCall = {
  id: "call-runs-without-load",
  label: "call set-scope with runs only and load hidden",
  args: { scope: "runOnly", hide: ["load"] },
};
const runsOnly: ToolCall = {
  id: "call-runs-only",
  label: "call set-scope with runs only",
  args: { scope: "runOnly" },
};
const wholeBody: ToolCall = {
  id: "call-whole-body",
  label: "call set-scope with whole body",
  args: { scope: "wholeBody" },
};
const hideTrend: ToolCall = {
  id: "call-hide-trend",
  label: "call set-scope hiding trend",
  args: { hide: ["trend"] },
};

/**
 * The model switches the scope and hides a series. Asserted through what the
 * athlete would see (the scope pill, the legend, the drawn lines, the scope
 * note) and what the model is told (the reply and the context summary). The
 * scope switch goes through the same keyed fetch as the pill.
 */
export const ModelDrivenScope = meta.story({
  tags: ["!autodocs"],
  args: { app: null, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  render: () => (
    <ModelDrivenLoad
      host={toggleApp}
      data={mockTrainingLoadData}
      calls={[
        runsOnlyWithoutLoad,
        {
          id: "call-trend-both-ways",
          label: "call set-scope showing and hiding trend",
          args: { show: ["trend"], hide: ["trend"] },
        },
        {
          id: "call-whole-body-with-load",
          label: "call set-scope with whole body and load shown",
          args: { scope: "wholeBody", show: ["load"] },
        },
        {
          id: "call-hide-warnings",
          label: "call set-scope hiding the warnings",
          args: { hide: ["warnings"] },
        },
      ]}
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, summary, isError, button, curves } =
      modelDrivenProbes(canvasElement);
    const pill = (name: string) => canvas.getByRole("button", { name });
    const load = () => canvas.getByRole("button", { name: "Toggle Load" });
    const warningBars = () =>
      canvasElement.querySelectorAll(
        '.recharts-bar-rectangle path[fill="var(--chart-heartrate)"]',
      ).length;

    await expect(pill("Whole body")).toHaveAttribute("aria-pressed", "true");
    // ResponsiveContainer needs a resize tick before the chart mounts.
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(1));

    // Runs only with load hidden: the pill follows, the other scope is
    // fetched by the keyed store, and the load line leaves the chart. The
    // scope has not arrived when the call lands, so the reply says it is
    // switching rather than showing.
    await userEvent.click(button("call-runs-without-load"));
    await waitFor(() =>
      expect(said()).toBe(
        "Switching to runs only; it is still loading. Hidden: load.",
      ),
    );
    expect(isError()).toBe(false);
    await expect(pill("Runs only")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(canvas.getByText(runOnlyNote)).toBeVisible());
    await expect(load()).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(0));
    // The model is told what the card now shows once the debounce fires.
    await waitFor(
      () => {
        expect(summary()).toContain("runs only.");
        expect(summary()).toContain("Hidden series: load.");
      },
      { timeout: 3000 },
    );

    // A series both shown and hidden is refused by name and changes nothing.
    await userEvent.click(button("call-trend-both-ways"));
    await waitFor(() =>
      expect(said()).toBe("Cannot both show and hide trend."),
    );
    expect(isError()).toBe(true);
    await expect(
      canvas.getByRole("button", { name: "Toggle Trend" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(pill("Runs only")).toHaveAttribute("aria-pressed", "true");

    // Back to whole body with load shown: the mount data is held, so the
    // chart is on screen and the reply may say it is showing.
    await userEvent.click(button("call-whole-body-with-load"));
    await waitFor(() =>
      expect(said()).toBe("Showing whole body. Nothing hidden."),
    );
    await expect(pill("Whole body")).toHaveAttribute("aria-pressed", "true");
    await expect(load()).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText(wholeBodyNote)).toBeVisible();
    await waitFor(() => expect(curves("var(--chart-power)")).toBe(1));

    // The warning highlight leaves the bars it recoloured.
    await waitFor(() => expect(warningBars()).toBeGreaterThan(0));
    await userEvent.click(button("call-hide-warnings"));
    await waitFor(() =>
      expect(said()).toBe("Showing whole body. Hidden: warnings."),
    );
    await waitFor(() => expect(warningBars()).toBe(0));

    // The other scope is held by now, so a switch to it is "showing" too.
    await userEvent.click(button("call-runs-without-load"));
    await waitFor(() =>
      expect(said()).toBe("Showing runs only. Hidden: load, warnings."),
    );
  },
});

/**
 * The scope the model asks for is still loading: the state is kept and the
 * reply says it is switching, never that it is showing. The hidden series is
 * still hidden once the athlete is back on a chart.
 */
export const ModelDrivenScopeLoading = meta.story({
  tags: ["!autodocs"],
  args: { app: null, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  render: () => (
    <ModelDrivenLoad
      host={slowApp}
      data={mockTrainingLoadData}
      calls={[runsOnlyWithoutLoad, wholeBody]}
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, isError, button } = modelDrivenProbes(canvasElement);

    await userEvent.click(button("call-runs-without-load"));
    await waitFor(() =>
      expect(said()).toBe(
        "Switching to runs only; it is still loading. Hidden: load.",
      ),
    );
    expect(isError()).toBe(false);
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent(
        "Listed 200 activities",
      ),
    );

    await userEvent.click(button("call-whole-body"));
    await waitFor(() =>
      expect(said()).toBe("Showing whole body. Hidden: load."),
    );
    await expect(
      canvas.getByRole("button", { name: "Toggle Load" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
});

/**
 * The scope the model asked for fails to load: the reply is an error carrying
 * what the card shows, the series change is kept, and the athlete's retry
 * brings the chart back with it.
 */
export const ModelDrivenScopeFails = meta.story({
  tags: ["!autodocs"],
  args: { app: null, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  beforeEach: () => {
    flakyCalls = 0;
  },
  render: () => (
    <ModelDrivenLoad
      host={flakyApp}
      data={mockTrainingLoadData}
      calls={[runsOnly, hideTrend]}
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, isError, button } = modelDrivenProbes(canvasElement);

    await userEvent.click(button("call-runs-only"));
    await waitFor(() =>
      expect(said()).toBe(
        "Switching to runs only; it is still loading. Nothing hidden.",
      ),
    );
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(/Request timed out/),
    );

    await userEvent.click(button("call-hide-trend"));
    await waitFor(() =>
      expect(said()).toBe(
        "Runs only failed to load: MCP error -32001: Request timed out. The card shows the error with a retry. Hidden: trend.",
      ),
    );
    expect(isError()).toBe(true);

    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(canvas.getByText(runOnlyNote)).toBeVisible());
    await expect(
      canvas.getByRole("button", { name: "Toggle Trend" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
});

/**
 * A window with no runs has no chart and no legend, so a series change is
 * refused with nothing changed. A scope on its own is accepted, since the
 * tiles change with it, and the reply says no chart is drawn.
 */
export const ModelDrivenScopeNoRuns = meta.story({
  tags: ["!autodocs"],
  args: { app: null, data: noRunsData, dataArgs: wholeBodyArgs },
  render: () => (
    <ModelDrivenLoad
      host={answering((runOnly) =>
        runOnly
          ? { ...noRunsData, runOnly: true, source: "computed" }
          : noRunsData,
      )}
      data={noRunsData}
      calls={[hideTrend, runsOnly]}
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { said, isError, button } = modelDrivenProbes(canvasElement);

    await expect(canvas.getByText("No runs in this period.")).toBeVisible();
    await userEvent.click(button("call-hide-trend"));
    await waitFor(() =>
      expect(said()).toBe(
        "Whole body has no runs in this period, so there is no chart to show or hide series on. Nothing was changed.",
      ),
    );
    expect(isError()).toBe(true);

    await userEvent.click(button("call-runs-only"));
    await waitFor(() =>
      expect(said()).toBe(
        "Switching to runs only; it is still loading. Nothing hidden.",
      ),
    );
    await waitFor(() =>
      expect(canvas.getByText(/Run-only load/)).toBeVisible(),
    );
    await userEvent.click(button("call-runs-only"));
    await waitFor(() =>
      expect(said()).toBe(
        "Showing runs only: no runs in this period, so no chart is drawn, only the totals and fitness tiles.",
      ),
    );
  },
});

/**
 * Interaction test (ljcl/strava-mcp#164): the legend's Trend toggle removes the rolling
 * trend line while the weekly bars and the load line stay. Recharts drops a
 * hidden Line's path from the SVG, so the curve count proves the line really
 * left the chart.
 */
export const LegendToggleHidesTrend = meta.story({
  args: { app: null, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The week in progress's hollow load point rides on a stroke-less line
    // (`stroke="none"`) that is not a curve anyone sees.
    const curveCount = () =>
      canvasElement.querySelectorAll(
        'path.recharts-line-curve:not([stroke="none"])',
      ).length;
    const barCount = () =>
      canvasElement.querySelectorAll(".recharts-bar-rectangle").length;
    // ResponsiveContainer needs a resize tick before the chart mounts. Two
    // curves: the trend line and the load line.
    await waitFor(() => expect(curveCount()).toBe(2));

    const trendToggle = canvas.getByRole("button", { name: "Toggle Trend" });
    await expect(trendToggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(trendToggle);

    await expect(trendToggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(curveCount()).toBe(1));
    await expect(barCount()).toBeGreaterThan(0);
  },
});

/**
 * A past window (#80): `newest` cut the last week off on a Wednesday. The
 * legend calls its light bar a partial week, not this week so far, and the
 * other scope is fetched for the same `newest`.
 */
export const PastWindow = meta.story({
  args: {
    app: countingApp,
    data: mockPastTrainingLoadData,
    dataArgs: pastArgs,
  },
  beforeEach: () => {
    toggleCalls = [];
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText("Partial week")).toBeVisible();
    await expect(canvas.queryByText("This week so far")).toBeNull();
    // The subtitle ends on the window's last day, year included.
    await expect(
      canvas.getByText(buildLoadSubtitle(mockPastTrainingLoadData)),
    ).toBeVisible();
    await expect(canvas.getByText(/– 24 Jun 2026$/)).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Runs only" }));
    await waitFor(() => expect(canvas.getByText(runOnlyNote)).toBeVisible());
    await expect(toggleCalls).toEqual([
      { days: 84, runOnly: true, newest: "2026-06-24" },
    ]);
  },
});

export const MobilePastWindow = meta.story({
  args: {
    app: null,
    data: mockPastTrainingLoadData,
    dataArgs: pastArgs,
    mode: "mobile",
  },
  ...mobile,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Partial week")).toBeVisible();
  },
});

export const Dark = meta.story({
  args: { app: null, data: mockTrainingLoadData, dataArgs: wholeBodyArgs },
  globals: darkGlobals,
});

export const MobileWholeBody = meta.story({
  args: {
    app: null,
    data: mockTrainingLoadData,
    dataArgs: wholeBodyArgs,
    mode: "mobile",
  },
  ...mobile,
});

export const MobileRunOnly = meta.story({
  args: {
    app: null,
    data: mockRunOnlyTrainingLoadData,
    dataArgs: runOnlyArgs,
    mode: "mobile",
  },
  ...mobile,
});
