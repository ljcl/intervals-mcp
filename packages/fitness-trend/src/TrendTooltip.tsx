import { Tooltip, TooltipEntry } from "@intervals-mcp/ui";
import { type ChartRow, signedTsb } from "./normalize";
import styles from "./TrendTooltip.module.css";

interface TrendTooltipPayloadItem {
  payload?: Partial<ChartRow>;
}

interface TrendTooltipProps {
  active?: boolean;
  payload?: TrendTooltipPayloadItem[];
  /** True when the forward half is a solved taper rather than rest. */
  planned?: boolean;
}

/**
 * One tooltip for both halves of the chart. A projected day has no recorded
 * `ctl`, so it reads its values off the `plan*` keys and says which it is —
 * a number that looks recorded but is prescribed would be the worst outcome.
 */
export function TrendTooltip({ active, payload, planned }: TrendTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  const recorded = row.ctl != null;
  const ctl = recorded ? row.ctl : row.planCtl;
  const atl = recorded ? row.atl : row.planAtl;
  const tsb = recorded ? row.tsb : row.planTsb;
  const load = recorded ? row.load : row.planLoad;

  return (
    <Tooltip timestamp={row.label ?? ""}>
      {!recorded && (
        <div className={styles.projected}>
          {planned ? "Planned" : "Projected (rest)"}
        </div>
      )}
      {ctl != null && (
        <TooltipEntry
          color="var(--chart-pace)"
          label="Fitness"
          value={`${ctl}`}
          unit=""
        />
      )}
      {atl != null && (
        <TooltipEntry
          color="var(--chart-heartrate)"
          label="Fatigue"
          value={`${atl}`}
          unit=""
        />
      )}
      {tsb != null && (
        <TooltipEntry
          color="var(--chart-power)"
          label="Form"
          value={signedTsb(tsb)}
          unit=""
        />
      )}
      {load != null && load > 0 && (
        <TooltipEntry
          color="var(--color-text-tertiary)"
          label={recorded ? "Load" : "Planned load"}
          value={`${load}`}
          unit=""
        />
      )}
    </Tooltip>
  );
}
