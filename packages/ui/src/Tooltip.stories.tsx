import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { Tooltip, TooltipEntry } from "./Tooltip";

function TooltipDemo() {
  return (
    <Tooltip timestamp="12:30">
      <TooltipEntry
        color="var(--chart-heartrate)"
        label="Heart Rate"
        value="162"
        unit="bpm"
      />
      <TooltipEntry
        color="var(--chart-power)"
        label="Power"
        value="245"
        unit="W"
      />
      <TooltipEntry
        color="var(--chart-pace)"
        label="Pace"
        value="4'32&quot;"
        unit="min/km"
      />
    </Tooltip>
  );
}

const meta = preview.meta({
  component: TooltipDemo,
});

export const Default = meta.story({});

export const Dark = meta.story({
  globals: darkGlobals,
});
