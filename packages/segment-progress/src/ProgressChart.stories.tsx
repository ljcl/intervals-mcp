import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect, waitFor } from "storybook/test";
import {
  mockSegment,
  mockSegmentProgressData,
  sparseSegmentProgressData,
} from "./__fixtures__/efforts";
import { ProgressChart } from "./ProgressChart";

const meta = preview.meta({ component: ProgressChart });

const base = {
  segment: mockSegment,
  efforts: mockSegmentProgressData.efforts,
  summary: mockSegmentProgressData.summary,
  showHeartrate: true,
};

export const Default = meta.story({ args: base });

/** Time series alone — the shape of the progression without the overlay. */
export const HeartrateHidden = meta.story({
  args: { ...base, showHeartrate: false },
});

/** No heart rate recorded: the right axis and overlay drop out entirely. */
export const NoHeartrate = meta.story({
  args: {
    segment: sparseSegmentProgressData.segment,
    efforts: sparseSegmentProgressData.efforts,
    summary: sparseSegmentProgressData.summary,
    showHeartrate: true,
  },
});

export const Empty = meta.story({
  args: { ...base, efforts: [] },
});

/**
 * Render test: exactly one dot per effort, with the personal best in gold
 * and the two runner-ups in the top-three purple — so neither a lost
 * highlight nor a phantom extra dot can slip through.
 */
export const HighlightedEfforts = meta.story({
  args: base,
  tags: ["!autodocs"],
  play: async ({ canvasElement }) => {
    const dots = () =>
      Array.from(canvasElement.querySelectorAll(".recharts-line-dots circle"));
    await waitFor(() =>
      expect(dots()).toHaveLength(mockSegmentProgressData.efforts.length),
    );

    const fills = dots().map((dot) => dot.getAttribute("fill"));
    expect(
      fills.filter((fill) => fill === "var(--color-tier-pr)"),
    ).toHaveLength(1);
    expect(
      fills.filter((fill) => fill === "var(--color-tier-top10)"),
    ).toHaveLength(2);
  },
});

export const Dark = meta.story({ args: base, globals: darkGlobals });

export const Mobile = meta.story({
  args: { ...base, mode: "mobile" },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <div style={{ height: 240 }}>
          <StoryFn />
        </div>
      </MobileCardShell>
    ),
  ],
});
