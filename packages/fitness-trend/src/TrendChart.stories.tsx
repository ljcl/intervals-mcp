import preview from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import {
  mockFitnessTrendData,
  mockNoLoadData,
  mockRestProjectionData,
} from "./__fixtures__/trend";
import { TrendChart } from "./TrendChart";

const meta = preview.meta({ component: TrendChart });

const allOn = {
  showCtl: true,
  showAtl: true,
  showTsb: true,
  showPlan: true,
  hiddenBandKinds: [],
};

export const Default = meta.story({
  args: { data: mockFitnessTrendData, ...allOn },
});

export const RestProjection = meta.story({
  args: { data: mockRestProjectionData, ...allOn },
});

/** Fitness and form only — the shape most athletes read first. */
export const FatigueHidden = meta.story({
  args: { data: mockFitnessTrendData, ...allOn, showAtl: false },
});

/** Recorded history alone, with the forward half switched off. */
export const PlanHidden = meta.story({
  args: { data: mockFitnessTrendData, ...allOn, showPlan: false },
});

/** Fatigue shading off, ramp shading on — the two overlap in this window. */
export const FatigueBandsHidden = meta.story({
  args: {
    data: mockFitnessTrendData,
    ...allOn,
    hiddenBandKinds: ["deep-fatigue"],
  },
});

export const NoRecordedLoad = meta.story({
  args: { data: mockNoLoadData, ...allOn },
});

export const Mobile = meta.story({
  args: { data: mockFitnessTrendData, ...allOn, mode: "mobile" },
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
