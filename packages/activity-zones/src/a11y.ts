import { dominantBucket, paceBasisNote } from "@intervals-mcp/data";
import { buildZoneRows } from "./normalize";
import { type ZoneSet } from "./types";

/**
 * SVG <title>/<desc> narration for the zone chart, per the chart
 * accessibility convention: what the chart is, then every bar's value so a
 * non-visual user gets the same distribution the bars show.
 */
export function buildZonesA11y(
  set: ZoneSet,
  activityName: string,
  activityType: string,
): { title: string; desc: string } {
  const label = { heartrate: "heart rate", power: "power", pace: "pace" }[
    set.type
  ];
  const rows = buildZoneRows(set, activityType);
  const top = dominantBucket(set);

  const parts = rows.map(
    (row) => `${row.label} (${row.range}) ${row.pct}% (${row.minutes} min)`,
  );
  return {
    title: `Time in ${label} zones for ${activityName}`,
    desc:
      `Bar chart of time spent in each ${label} zone` +
      (set.basis ? ` (${paceBasisNote(set.basis)}). ` : ". ") +
      `Most time in Z${top.zone} at ${top.pct}%. ` +
      parts.join(", ") +
      ".",
  };
}
