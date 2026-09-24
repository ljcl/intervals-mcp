import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import { type ZoneRow } from "./normalize";

interface ZoneTooltipPayloadItem {
  payload?: ZoneRow;
}

interface ZoneTooltipProps {
  active?: boolean;
  payload?: ZoneTooltipPayloadItem[];
  /** Bar color for the active zone set. */
  color: string;
}

export function ZoneTooltip({ active, payload, color }: ZoneTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <Tooltip timestamp={`${row.label} · ${row.range}`}>
      <TooltipEntry
        color={color}
        label="Time"
        value={`${row.minutes}`}
        unit="min"
      />
      <TooltipEntry
        color="var(--color-text-tertiary)"
        label="Share"
        value={`${row.pct}`}
        unit="%"
      />
    </Tooltip>
  );
}
