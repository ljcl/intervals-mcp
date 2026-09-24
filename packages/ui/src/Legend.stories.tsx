import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { Legend, LegendItem } from "./Legend";
import { MobileCardShell } from "./MobileCardShell";

const meta = preview.meta({
  component: Legend,
});

export const Default = meta.story({
  render: () => (
    <Legend>
      <LegendItem color="var(--chart-heartrate)" label="Heart Rate" />
      <LegendItem color="var(--chart-power)" label="Power" />
      <LegendItem color="var(--chart-pace)" label="Pace" hidden />
      <LegendItem color="var(--chart-altitude)" label="Altitude" />
    </Legend>
  ),
});

export const Dark = meta.story({
  globals: darkGlobals,
  render: () => (
    <Legend>
      <LegendItem color="var(--chart-heartrate)" label="Heart Rate" />
      <LegendItem color="var(--chart-power)" label="Power" />
      <LegendItem color="var(--chart-pace)" label="Pace" hidden />
      <LegendItem color="var(--chart-altitude)" label="Altitude" />
    </Legend>
  ),
});

export const Faded = meta.story({
  render: () => (
    <Legend>
      <LegendItem color="var(--chart-heartrate)" label="Heart Rate" />
      <LegendItem color="var(--chart-power)" label="Power" faded />
      <LegendItem color="var(--chart-pace)" label="Pace" faded />
      <LegendItem color="var(--chart-altitude)" label="Altitude" />
    </Legend>
  ),
});

export const Touch = meta.story({
  render: () => (
    <Legend size="touch">
      <LegendItem color="var(--chart-heartrate)" label="Heart Rate" />
      <LegendItem color="var(--chart-power)" label="Power" />
      <LegendItem color="var(--chart-pace)" label="Pace" hidden />
      <LegendItem color="var(--chart-altitude)" label="Altitude" />
    </Legend>
  ),
});

export const Mobile = meta.story({
  render: () => (
    <Legend size="touch">
      <LegendItem color="var(--chart-heartrate)" label="Heart Rate" />
      <LegendItem color="var(--chart-power)" label="Power" />
      <LegendItem color="var(--chart-pace)" label="Pace" faded />
      <LegendItem color="var(--chart-altitude)" label="Altitude" hidden />
    </Legend>
  ),
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
