import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { fn } from "storybook/test";
import {
  mockSegmentProgressData,
  sparseSegmentProgressData,
} from "./__fixtures__/efforts";
import { EffortList } from "./EffortList";
import { newestFirst } from "./normalize";

const meta = preview.meta({ component: EffortList });

const base = {
  efforts: newestFirst(mockSegmentProgressData.efforts),
  activityType: "Run",
  bestSeconds: mockSegmentProgressData.summary.bestSeconds,
  withYear: true,
  onOpenChange: fn(),
};

export const Default = meta.story({ args: base });

/** No heart rate and a same-year history: the summary line stays short. */
export const Sparse = meta.story({
  args: {
    ...base,
    efforts: newestFirst(sparseSegmentProgressData.efforts),
    bestSeconds: sparseSegmentProgressData.summary.bestSeconds,
    withYear: false,
  },
});

/** Ride segments read in km/h rather than min/km. */
export const RideSegment = meta.story({
  args: { ...base, activityType: "Ride" },
});

export const Dark = meta.story({ args: base, globals: darkGlobals });

export const Mobile = meta.story({
  args: { ...base, compact: true },
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
