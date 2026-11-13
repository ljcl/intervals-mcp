import { dominantBucket, intensitySplit } from "@intervals-mcp/data";
import { zoneSetLabel, zoneSetTitle } from "./normalize";
import { type ActivityZonesData, type ZoneSet } from "./types";

/**
 * One-line summary of what the chart is showing, synced to the host so the
 * model can talk about the visible state without re-calling the data tool.
 * `activeType` is the set on screen (the pill the athlete picked, or the one
 * `set-zone-type` switched to); without it, the first set, as the card opens.
 * When the server dropped heart rate zones, its reason (`hrZoneWarning`)
 * closes the summary, as it closes the text tools' output; a card with no set
 * to chart still reports that reason. Null when there is nothing to report.
 */
export function buildZonesContextSummary(
  data: ActivityZonesData,
  activeType?: ZoneSet["type"],
): string | null {
  const warning = data.hrZoneWarning;
  if (data.zoneSets.length === 0) {
    return warning
      ? `No zone data to show for ${data.name} (${data.type}). ${warning}`
      : null;
  }

  const parts = [`Time-in-zone for ${data.name} (${data.type}).`];
  for (const set of data.zoneSets) {
    const label = zoneSetLabel(set);
    const top = dominantBucket(set);
    const split = intensitySplit(set.buckets.map((b) => b.seconds));
    parts.push(
      `${label}: mostly Z${top.zone} (${top.pct}%), split ${split.easyPct}% easy / ${split.moderatePct}% moderate / ${split.hardPct}% hard.`,
    );
  }
  const active =
    data.zoneSets.find((set) => set.type === activeType) ?? data.zoneSets[0]!;
  parts.push(`On screen: ${zoneSetTitle(active)}.`);
  if (warning) parts.push(warning);
  return parts.join(" ");
}
