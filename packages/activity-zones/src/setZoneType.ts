import { ZONE_SET_NAMES, zoneSetTitle } from "./normalize";
import { type ActivityZonesData, type ZoneSet } from "./types";

/**
 * The zone sets `set-zone-type` can switch to. Power is left out: the server
 * drops power zones for now (docs/api-notes.md), so no card offers it.
 */
export const ZONE_TYPES = ["heartrate", "pace"] as const;
export type ZoneTypeArg = (typeof ZONE_TYPES)[number];

/** `set-zone-type` arguments after the registry has dropped the nulls. */
export interface SetZoneTypeArgs {
  type?: ZoneTypeArg;
}

export type SetZoneTypeResult =
  | { kind: "ok"; set: ZoneSet }
  | { kind: "error"; text: string };

/** Shown when the card has no chart, so there is no set to switch to. */
export const NO_ZONE_SETS =
  "This activity has no zone set to show, so there is nothing to switch.";

/**
 * A set type as the model can send it, with the name the card shows beside
 * it where that differs: "heartrate (heart rate)", "pace".
 */
function sendable(type: ZoneSet["type"]): string {
  const shown = ZONE_SET_NAMES[type].toLowerCase();
  return shown === type ? type : `${type} (${shown})`;
}

/**
 * Settle a `set-zone-type` call against the sets the activity has, before
 * anything on screen changes. A set the activity lacks is refused with the
 * available ones named by the value the schema accepts; a heart rate request
 * the server dropped carries the server's reason (`hrZoneWarning`), the same
 * line the card and the text tools show.
 */
export function resolveSetZoneType(
  args: SetZoneTypeArgs,
  data: Pick<ActivityZonesData, "zoneSets" | "hrZoneWarning">,
): SetZoneTypeResult {
  const reason = data.hrZoneWarning ? ` ${data.hrZoneWarning}` : "";
  if (data.zoneSets.length === 0) {
    return { kind: "error", text: `${NO_ZONE_SETS}${reason}` };
  }
  if (args.type === undefined) return { kind: "error", text: "Pass type." };

  const set = data.zoneSets.find((s) => s.type === args.type);
  if (set) return { kind: "ok", set };

  const available = data.zoneSets.map((s) => sendable(s.type)).join(", ");
  const why = args.type === "heartrate" ? reason : "";
  return {
    kind: "error",
    text: `This activity has no ${ZONE_SET_NAMES[args.type].toLowerCase()} zones.${why} Available: ${available}. Nothing was changed.`,
  };
}

/**
 * One line telling the model what the card now shows, in the subtitle's
 * words: "Showing Pace zones (GAP)."
 */
export function describeSetZoneType(set: ZoneSet): string {
  return `Showing ${zoneSetTitle(set)}.`;
}
