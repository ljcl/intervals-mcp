import { dominantBucket } from "@intervals-mcp/data";
import { intensitySplit } from "./normalize";
import { type ActivityZonesData } from "./types";

/**
 * One-line summary of what the chart is showing, synced to the host so the
 * model can talk about the visible state without re-calling the data tool.
 */
export function buildZonesContextSummary(
  data: ActivityZonesData,
): string | null {
  if (data.zoneSets.length === 0) return null;

  const parts = [`Time-in-zone for ${data.name} (${data.type}).`];
  for (const set of data.zoneSets) {
    const label = set.type === "heartrate" ? "Heart rate" : "Power";
    const top = dominantBucket(set);
    const split = intensitySplit(set);
    parts.push(
      `${label}: mostly Z${top.zone} (${top.pct}%), split ${split.easyPct}% easy / ${split.moderatePct}% moderate / ${split.hardPct}% hard.`,
    );
  }
  return parts.join(" ");
}
