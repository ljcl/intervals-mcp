import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { expect } from "storybook/test";
import { mockSegmentProgressData } from "./__fixtures__/efforts";
import { buildChartRows } from "./normalize";
import { ProgressTooltip } from "./ProgressTooltip";

/**
 * The hover tooltip for one point on the effort chart. It only ever renders
 * inside Recharts' tooltip layer, which is why the per-story axe check never
 * reached its achievement badge and a `--color-text-inverse` foreground on
 * the theme-invariant tier backgrounds survived the #286 sweep. Rendering it
 * standalone here puts both badge tiers under the same contrast gate as
 * everything else.
 */
const meta = preview.meta({ component: ProgressTooltip });

const rows = buildChartRows(mockSegmentProgressData.efforts);
const prRow = rows.find((r) => r.rank === 1) ?? rows[0]!;
const topRow = rows.find((r) => r.rank !== 1 && r.komRank != null) ?? rows[0]!;

const base = {
  active: true,
  activityType: "Run",
  bestSeconds: mockSegmentProgressData.summary.bestSeconds,
};

/** The fastest effort in the history — gold "Personal best" badge. */
export const PersonalBest = meta.story({
  args: { ...base, payload: [{ payload: prRow }] },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Personal best")).toBeInTheDocument();
  },
});

/** A mid-season top-10 — the purple tier, the other half of the pairing. */
export const TopTen = meta.story({
  args: { ...base, payload: [{ payload: topRow }] },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/^Top \d+$/)).toBeInTheDocument();
  },
});

/**
 * The tier colours carry no dark override, so the badge foreground must clear
 * contrast in both themes off one token — the whole point of the fix.
 */
export const Dark = meta.story({
  args: { ...base, payload: [{ payload: prRow }] },
  globals: darkGlobals,
});
