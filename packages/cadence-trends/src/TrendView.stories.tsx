import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, waitFor } from "storybook/test";
import { mockRuns } from "./__fixtures__/runs";
import { TrendView } from "./TrendView";

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

/**
 * Click-to-select (#275) was render-only smoke tested, so a broken click
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
