import { z } from "zod";

/**
 * Strava's SportType values, the vocabulary both write tools accept.
 *
 * Mirrors the SportType model in Strava's API reference. It is pinned here
 * rather than fetched because there is no machine-readable feed for it — which
 * means an upstream addition is a local rejection until this list is updated,
 * so the failure mode is a user unable to log a sport Strava now supports. If
 * that is reported, add the value here; nothing else needs to change, since
 * both the advertised JSON Schema and the runtime check derive from this array.
 */
export const SPORT_TYPES = [
  "AlpineSki",
  "BackcountrySki",
  "Badminton",
  "Canoeing",
  "Crossfit",
  "EBikeRide",
  "Elliptical",
  "EMountainBikeRide",
  "Golf",
  "GravelRide",
  "Handcycle",
  "HighIntensityIntervalTraining",
  "Hike",
  "IceSkate",
  "InlineSkate",
  "Kayaking",
  "Kitesurf",
  "MountainBikeRide",
  "NordicSki",
  "Pickleball",
  "Pilates",
  "Racquetball",
  "Ride",
  "RockClimbing",
  "RollerSki",
  "Rowing",
  "Run",
  "Sail",
  "Skateboard",
  "Snowboard",
  "Snowshoe",
  "Soccer",
  "Squash",
  "StairStepper",
  "StandUpPaddling",
  "Surfing",
  "Swim",
  "TableTennis",
  "Tennis",
  "TrailRun",
  "Velomobile",
  "VirtualRide",
  "VirtualRow",
  "VirtualRun",
  "Walk",
  "WeightTraining",
  "Wheelchair",
  "Windsurf",
  "Workout",
  "Yoga",
] as const;

export type SportType = (typeof SPORT_TYPES)[number];

/** Length of the longest case-insensitive common prefix. */
function prefixScore(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/**
 * Sport types a rejected value probably meant. A bare "not one of 50 values"
 * error is technically complete and practically useless; "Weightlifting" →
 * WeightTraining is the correction the caller can act on. Case-only misses
 * ("run") rank first because they are the most common.
 */
export function suggestSportTypes(input: string, limit = 3): SportType[] {
  if (!input) return [];
  return SPORT_TYPES.map((type) => ({ type, score: prefixScore(input, type) }))
    .filter((candidate) => candidate.score >= 3)
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type))
    .slice(0, limit)
    .map((candidate) => candidate.type);
}

/**
 * The shared input schema for both write tools. `toInputSchema` publishes the
 * enum, so a host advertises every valid value and the model picks one without
 * a failed round-trip to Strava.
 */
export const SportTypeSchema = z.enum(SPORT_TYPES, {
  error: (issue) => {
    const received = typeof issue.input === "string" ? issue.input : "";
    const suggestions = suggestSportTypes(received);
    const lead = received
      ? `"${received}" is not a Strava sport type.`
      : "A Strava sport type is required.";
    const hint =
      suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
    return `${lead}${hint} Valid values: ${SPORT_TYPES.join(", ")}.`;
  },
});

export type DescriptionMode = "append" | "replace";

export interface UpdateActivityParams {
  name?: string;
  description?: string;
  sportType?: SportType;
  gearId?: string;
  commute?: boolean;
  trainer?: boolean;
  hideFromHome?: boolean;
}

/**
 * Resolves the final description string to send to Strava.
 * Append preserves any existing description, separated by a blank line.
 */
export function composeDescription(
  existing: string | null | undefined,
  incoming: string,
  mode: DescriptionMode,
): string {
  if (mode === "replace") {
    return incoming;
  }
  if (!existing || existing.trim() === "") {
    return incoming;
  }
  return `${existing}\n\n${incoming}`;
}

/**
 * Builds the UpdatableActivity PUT body, including only provided fields
 * and mapping camelCase params to Strava's snake_case keys.
 */
export function buildUpdateActivityBody(
  updates: UpdateActivityParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (updates.name !== undefined) body.name = updates.name;
  if (updates.description !== undefined) body.description = updates.description;
  if (updates.sportType !== undefined) body.sport_type = updates.sportType;
  if (updates.gearId !== undefined) body.gear_id = updates.gearId;
  if (updates.commute !== undefined) body.commute = updates.commute;
  if (updates.trainer !== undefined) body.trainer = updates.trainer;
  if (updates.hideFromHome !== undefined)
    body.hide_from_home = updates.hideFromHome;
  return body;
}
