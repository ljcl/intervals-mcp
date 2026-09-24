import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "./MobileCardShell";
import { SummaryBar } from "./SummaryBar";

const meta = preview.meta({
  component: SummaryBar,
});

export const WithTrend = meta.story({
  args: {
    stats: [
      { label: "Avg Cadence", value: "174 spm" },
      { label: "Trend", value: "+3 spm", direction: "up" },
      { label: "Runs", value: "15 in 6w" },
    ],
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: {
    stats: [
      { label: "Avg Cadence", value: "174 spm" },
      { label: "Trend", value: "+3 spm", direction: "up" },
      { label: "Runs", value: "15 in 6w" },
    ],
  },
});

export const Declining = meta.story({
  args: {
    stats: [
      { label: "Avg Cadence", value: "168 spm" },
      { label: "Trend", value: "-2 spm", direction: "down" },
      { label: "Runs", value: "12 in 6w" },
    ],
  },
});

export const Totals = meta.story({
  args: {
    stats: [
      { label: "Runs", value: "34" },
      { label: "Distance", value: "312.4 km" },
      { label: "Time", value: "27h 45m" },
      { label: "Elevation", value: "2,810 m" },
    ],
  },
});

export const Mobile = meta.story({
  args: {
    stats: [
      { label: "Avg Cadence", value: "174 spm" },
      { label: "Trend", value: "flat", direction: "flat" },
      { label: "Runs", value: "15 in 6w" },
    ],
    compact: true,
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
