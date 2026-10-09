/**
 * intervals.icu's achievements (`icu_achievements`): the bests and threshold
 * rises it marks on an activity. The one home for their mapping, labels and
 * text, shared by `get-activity` (and so `get-running-summary`) and
 * `list-activities`.
 *
 * Only `LTHR_UP` has been seen live (docs/api-notes.md). The other types
 * (`BEST_PACE`, `BEST_POWER`, `FTP_UP`) follow the OpenAPI shape, so values
 * pass through unconverted and the text leans on intervals.icu's own
 * `message`.
 */
import { formatDuration } from "./formatters";
import { type IntervalsActivity } from "./intervalsClient";

/** One achievement as the tools report it (`AchievementSchema` in outputs.ts). */
export interface Achievement {
  type: string;
  message: string | null;
  value: number | null;
  duration_s: number | null;
  distance_m: number | null;
  watts: number | null;
  pace_mps: number | null;
}

const LABELS: Record<string, string> = {
  BEST_PACE: "Best pace",
  BEST_POWER: "Best power",
  LTHR_UP: "LTHR up",
  FTP_UP: "FTP up",
};

/**
 * The threshold types. A threshold belongs to the sport settings group that
 * covers the activity's type: a swim's LTHR_UP is about the swim LTHR, not
 * the run LTHR (docs/api-notes.md). So their label names the activity type.
 */
const PER_SPORT_TYPES = new Set(["LTHR_UP", "FTP_UP"]);

/**
 * Text label for an achievement type: "Swim LTHR up" for a threshold type
 * (the activity type first), "Best pace" for a best. An unknown type shows
 * as sent.
 */
export function achievementLabel(type: string, activityType: string): string {
  const label = LABELS[type] ?? type;
  return PER_SPORT_TYPES.has(type) ? `${activityType} ${label}` : label;
}

/**
 * `icu_achievements` as the tools report them: `[]` for null, and an entry
 * with no type is dropped. `duration_s` is `secs`, else the curve point's
 * `secs` (an LTHR_UP sends only the point's). Values pass through
 * unconverted. Only LTHR_UP's `value` is verified: the LTHR in bpm that
 * intervals.icu estimated from the effort. It does not show that the sport
 * settings changed.
 */
export function mapAchievements(
  raw: IntervalsActivity["icu_achievements"],
): Achievement[] {
  return (raw ?? []).flatMap((a) =>
    typeof a.type === "string" && a.type !== ""
      ? [
          {
            type: a.type,
            message: a.message?.trim() || null,
            value: a.value ?? null,
            duration_s: a.secs ?? a.point?.secs ?? null,
            distance_m: a.distance ?? null,
            watts: a.watts ?? null,
            pace_mps: a.pace ?? null,
          },
        ]
      : [],
  );
}

/** The distinct achievement types, in the order sent: list-activities' flag. */
export function achievementTypes(
  raw: IntervalsActivity["icu_achievements"],
): string[] {
  return [...new Set(mapAchievements(raw).map((a) => a.type))];
}

/**
 * The effort behind an achievement with no `message`, from the fields sent:
 * "400 W for 5:00", or "5000 m in 25:00". Null when none is set.
 */
function effortText(a: Achievement): string | null {
  const parts: string[] = [];
  if (a.watts != null) parts.push(`${Math.round(a.watts)} W`);
  if (a.distance_m != null) parts.push(`${Math.round(a.distance_m)} m`);
  if (a.duration_s != null)
    parts.push(
      `${a.distance_m != null ? "in" : "for"} ${formatDuration(a.duration_s)}`,
    );
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * One achievement as text. An LTHR_UP gives its estimate:
 * "Swim LTHR up: 172 bpm estimated (1h at 172 bpm)". It does not say "up
 * to", because the sport settings can still hold the old LTHR. Another type
 * gives the label and intervals.icu's message ("Best pace: 5km in 25:00"),
 * else the effort fields ("Best power: 400 W for 5:00").
 */
export function formatAchievement(
  a: Achievement,
  activityType: string,
): string {
  const label = achievementLabel(a.type, activityType);
  if (a.type === "LTHR_UP" && a.value != null)
    return `${label}: ${a.value} bpm estimated${a.message ? ` (${a.message})` : ""}`;
  const detail = a.message ?? effortText(a);
  return detail ? `${label}: ${detail}` : label;
}
