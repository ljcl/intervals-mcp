import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, waitFor } from "storybook/test";
import { mockRuns } from "./__fixtures__/runs";
import { ScatterView } from "./ScatterView";

const noop = () => {};

const meta = preview.meta({ component: ScatterView });

/** Plot order: runs with both cadence and pace, in the order given. */
const plotted = mockRuns.filter(
  (a) => a.averageCadence > 0 && a.averagePace > 0,
);

/** Every clickable run mark, in plot order. */
const runMarks = (root: HTMLElement) =>
  root.querySelectorAll<SVGPathElement>(
    ".recharts-scatter path.recharts-symbols",
  );

/**
 * Click-to-select (#275): the dots are the only interaction in this view
 * and were render-only smoke tested, so an id mismatch could not fail CI.
 */
export const Default = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: fn(),
    selectedRunIds: new Set<number>(),
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
    selectedRunIds: new Set<number>(),
  },
});

/** Selected runs are outlined, so the overlay selection is legible. */
export const WithSelectedRuns = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set([10003, 10013]),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(runMarks(canvasElement).length).toBeGreaterThan(0),
    );

    const outlined = [...runMarks(canvasElement)].filter(
      (mark) => mark.getAttribute("stroke-width") === "2",
    );
    expect(outlined).toHaveLength(2);
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set<number>(),
  },
});

export const Mobile = meta.story({
  args: {
    activities: mockRuns,
    onRunClick: noop,
    selectedRunIds: new Set<number>(),
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
