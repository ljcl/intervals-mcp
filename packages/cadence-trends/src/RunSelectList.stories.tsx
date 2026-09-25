import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, fn, within } from "storybook/test";
import { mockRuns } from "./__fixtures__/runs";
import { RunSelectList } from "./RunSelectList";

const meta = preview.meta({ component: RunSelectList });

export const Default = meta.story({
  args: {
    runs: mockRuns,
    selectedRunIds: new Set<string>(),
    onToggleRun: fn(),
  },
  play: async ({ canvas }) => {
    // Run dates read through the shared UTC formatter, so a chip names the
    // same day the narration and the axis do. `toLocaleDateString` printed
    // the host's locale format and shifted the day for viewers east of UTC.
    await expect(
      canvas.getByRole("button", { name: /^Easy 8k, 1 Jan 26, \d+ spm$/ }),
    ).toBeInTheDocument();
  },
});

export const SomeSelected = meta.story({
  args: {
    runs: mockRuns,
    selectedRunIds: new Set(["i10013", "i10003"]),
    onToggleRun: fn(),
  },
});

/**
 * Keyboard access (#169): the group is a single Tab stop with roving arrow-key
 * focus, and each chip activates on Enter/Space, calling back into the shared
 * selection toggle. The full select/deselect + aria-pressed flow is asserted at
 * the App level (state lives there); here we prove the keyboard plumbing.
 */
export const KeyboardActivation = meta.story({
  args: {
    runs: mockRuns,
    selectedRunIds: new Set<string>(),
    onToggleRun: fn(),
  },
  play: async ({ args, userEvent }) => {
    // Tab lands on the group's single roving stop, then arrow keys move within.
    await userEvent.tab();
    const first = document.activeElement as HTMLElement;
    await expect(first).toHaveAttribute("aria-pressed", "false");

    await userEvent.keyboard("{ArrowRight}");
    await expect(document.activeElement).not.toBe(first);

    await userEvent.keyboard("{Enter}");
    await expect(args.onToggleRun).toHaveBeenCalledTimes(1);
  },
});

/**
 * At the 4-run cap, unselected chips disable so the "up to 4" limit is a
 * legible, non-interactive state rather than a silently ignored click.
 */
export const AtCap = meta.story({
  args: {
    runs: mockRuns,
    selectedRunIds: new Set(["i10015", "i10014", "i10013", "i10012"]),
    onToggleRun: fn(),
  },
  play: async ({ canvas }) => {
    const group = canvas.getByRole("group", { name: /compare runs/i });
    // A selected chip stays interactive (you can still deselect it).
    await expect(
      within(group).getByRole("button", { name: /Intervals 5x1k/ }),
    ).toBeEnabled();
    // An unselected chip is disabled once the cap is reached.
    await expect(
      within(group).getByRole("button", { name: /Tempo Intervals/ }),
    ).toBeDisabled();
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: {
    runs: mockRuns,
    selectedRunIds: new Set(["i10013", "i10003"]),
    onToggleRun: fn(),
  },
});

export const Mobile = meta.story({
  args: {
    runs: mockRuns,
    selectedRunIds: new Set(["i10013"]),
    onToggleRun: fn(),
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
