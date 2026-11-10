import { type SummaryStat } from "@intervals-mcp/ui";
import { type SuggestionStats } from "./types";

const km = (metres: number) => (metres / 1000).toFixed(1);
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * A candidate's numbers for the stat strip, rounded as suggest-run-route's
 * text rounds them; a number the server could not work out is left out.
 */
export function suggestionStats(s: SuggestionStats): SummaryStat[] {
  const sign = s.distance_diff_m >= 0 ? "+" : "-";
  const stats: SummaryStat[] = [
    {
      label: "Distance",
      value: `${km(s.distance_m)} km (${sign}${km(Math.abs(s.distance_diff_m))})`,
    },
    { label: "Climb", value: `${s.climb_m} m, ${s.climb_per_km} m/km` },
    { label: "Score", value: String(s.score) },
  ];
  if (s.path_share !== null)
    stats.push({ label: "Paths", value: percent(s.path_share) });
  if (s.green_share !== null)
    stats.push({ label: "Parks or water", value: percent(s.green_share) });
  if (s.crossings_per_km !== null)
    stats.push({ label: "Crossings", value: `${s.crossings_per_km}/km` });
  if (s.signals_per_km !== null)
    stats.push({ label: "Signals", value: `${s.signals_per_km}/km` });
  if (s.main_road_km !== null)
    stats.push({ label: "Main roads", value: `${s.main_road_km} km` });
  return stats;
}

/** What lost the score points, as the text says it, or null when none did. */
export function scoreLossText(s: SuggestionStats): string | null {
  return s.losses.length > 0
    ? `Score lost: ${s.losses.map((l) => `${l.label} ${l.points}`).join(", ")}.`
    : null;
}

/** The planned run line: date, plan, distance, start and how it was chosen, end. */
export function suggestionContext(data: {
  date: string | null;
  name: string;
  distance_m: number | null;
  startLabel: string | null;
  startSource: string | null;
  endLabel: string | null;
}): string | null {
  if (!data.date) return null;
  const parts = [data.date, data.name];
  if (data.distance_m != null) parts.push(`${km(data.distance_m)} km planned`);
  if (data.startLabel)
    parts.push(
      `from ${data.startLabel}${data.startSource ? ` (${data.startSource})` : ""}`,
    );
  if (data.endLabel) parts.push(`to ${data.endLabel}`);
  return parts.join(" · ");
}
