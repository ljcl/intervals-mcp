import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import { pointLabel, type SeriesSpec } from "./normalize";
import { type WellnessTrendData, type WellnessTrendPoint } from "./types";

interface WellnessTooltipProps {
  active?: boolean;
  payload?: { payload?: WellnessTrendPoint }[];
  data: WellnessTrendData;
  spec: SeriesSpec;
}

/** The panel's own value on the hovered day; a gap day says so. */
export function WellnessTooltip({
  active,
  payload,
  data,
  spec,
}: WellnessTooltipProps) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  const value = point[spec.key];
  return (
    <Tooltip timestamp={pointLabel(data, point)}>
      <TooltipEntry
        color={spec.color}
        label={spec.label}
        value={value == null ? "No record" : `${value}`}
        unit={value == null ? "" : spec.unit}
      />
    </Tooltip>
  );
}
