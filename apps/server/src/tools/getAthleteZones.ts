import { z } from "zod";
import { hrZoneRangeText } from "../activityZones";
import {
  type AthletePaceZone,
  type AthleteZonesResponse,
  buildAthleteZones,
  coversSwim,
  groupTypes,
  HR_CURVE_IDS,
  type HrBest,
  type HrCurveRead,
  intervalsActivityType,
  type ResolvedSportGroup,
  resolveSportGroup,
} from "../athleteZones";
import {
  getAthleteHrCurves,
  type IntervalsSportSettings,
  listSportSettings,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { READ_ONLY } from "./_annotations";
import { prefixedErrorText, toolErrorText, unavailableReason } from "./_errors";
import { AthleteZonesOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-athlete-zones";

const description = `
Returns the athlete's own zones and thresholds from intervals.icu sport
settings, with units: LTHR, max HR, HR zones, threshold pace, pace zones and
FTP. Use it for "what are my HR zones?", "is 150 bpm zone 2 for me?" or
"what is my threshold pace?". It also compares LTHR and max HR with the
athlete's recent heart rate bests, and says when a setting looks out of date.

For the time spent in each zone on one activity, use get-activity-zones. It
uses the zone bounds recorded with that activity, which can be older than
these settings.

Notes:
- sport is an intervals.icu activity type (default Run). It picks the
  settings group that lists it; by default, TrailRun and VirtualRun are in
  the Run group. A type with no group of its own gets intervals.icu's
  default Other group, and the reply says so. A word that is not an
  activity type, such as Running or Cycling, is an error that lists the
  groups' types.
- A heart rate is in the first zone whose upper bound is at or above it.
- Pace zones are percentages of threshold speed. Pace is per km; a swim
  group also gets pace per 100 m.
- The LTHR check uses intervals.icu's own rule: the higher of the best
  60-minute heart rate and 98% of the best 20-minute heart rate, both in the
  last 90 days. The max HR check uses the best 60-second heart rate of the
  last year. A check flags only a setting that looks too low. It is a hint,
  not a rule: a heart rate sensor error can cause it. A best under half of
  max HR (sensor dropouts) is not used. If the heart rate curves cannot be
  read, the checks are skipped with a warning and the zones still return.
- Power zones are not covered.
`;

const inputSchema = z.object({
  sport: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(
      /^[A-Za-z][A-Za-z ]*$/,
      "Use an activity type such as Run, Ride or Swim.",
    )
    .default("Run")
    .describe(
      'intervals.icu activity type whose settings to return, such as "Run", "Ride" or "Swim" (not "Running" or "Cycling"). Matched against the types of each settings group, ignoring case and spaces; by default, TrailRun and VirtualRun are in the Run group. Default "Run".',
    ),
});

type GetAthleteZonesInput = z.infer<typeof inputSchema>;

/** The `isError` text when no group covers `sport`: it is not an
 * intervals.icu activity type, or there is no Other group to fall back to. */
function noGroupText(groups: IntervalsSportSettings[], sport: string): string {
  if (groups.length === 0) {
    return "No sport settings were found for this athlete.";
  }
  const listed = groupTypes(groups)
    .map((types) => types.join(", "))
    .join("; ");
  if (intervalsActivityType(sport) === null) {
    return `${sport} is not an intervals.icu activity type. Call again with an activity type, such as Run, Ride or Swim. Groups: ${listed}.`;
  }
  return `No intervals.icu settings group covers ${sport}, and there is no default Other group. Groups: ${listed}.`;
}

/**
 * Reads the HR curves for the resolved group. Never throws: the zones are
 * the answer and the check is extra, so a failed read degrades to a warning
 * (worded by `unavailableReason`; the raw message goes to the operator log).
 * The Other group is not read: intervals.icu answers with the Run curve for
 * its types (docs/api-notes.md).
 */
async function readHrCurves(
  apiKey: string,
  resolved: ResolvedSportGroup,
  progress: ReportProgress,
): Promise<HrCurveRead> {
  if (resolved.group.other === true) return { status: "skipped_other_group" };
  progress("Fetching heart rate curves");
  try {
    const curves = await getAthleteHrCurves(apiKey, {
      // The group's own spelling of the type, never the raw input.
      type: resolved.sport,
      curves: [...HR_CURVE_IDS],
    });
    return { status: "read", curves };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${name}: HR curve read failed: ${message}`);
    return { status: "failed", reason: unavailableReason(error) };
  }
}

/** " Easy" after "Z2", or nothing for a zone with no name. */
const zoneName = (label: string | null) => (label ? ` ${label}` : "");

function pctRange(zone: AthletePaceZone): string {
  if (zone.max_pct === null) {
    return zone.min_pct > 0 ? `over ${zone.min_pct}%` : "any speed";
  }
  return zone.min_pct > 0
    ? `${zone.min_pct}-${zone.max_pct}%`
    : `under ${zone.max_pct}%`;
}

function paceRange(
  slowest: string | null,
  fastest: string | null,
  suffix: string,
): string | null {
  if (slowest && fastest) return `${slowest}-${fastest} ${suffix}`;
  if (fastest) return `slower than ${fastest} ${suffix}`;
  if (slowest) return `faster than ${slowest} ${suffix}`;
  return null;
}

function paceZoneLine(zone: AthletePaceZone, swim: boolean): string {
  const pace = swim
    ? paceRange(zone.slowest_min_per_100m, zone.fastest_min_per_100m, "/100m")
    : paceRange(zone.slowest_min_per_km, zone.fastest_min_per_km, "/km");
  const pct = pctRange(zone);
  const label = `  Z${zone.zone}${zoneName(zone.name)}`;
  return pace ? `${label}: ${pace} (${pct})` : `${label}: ${pct}`;
}

function durationLabel(seconds: number): string {
  return seconds > 60 && seconds % 60 === 0
    ? `${seconds / 60} min`
    : `${seconds} s`;
}

function hrBestsLine(bests: HrBest[]): string | null {
  const windows: Array<[HrBest["window"], string]> = [
    ["90d", "last 90 days"],
    ["1y", "last year"],
  ];
  const parts = windows.flatMap(([window, label]) => {
    const points = bests.filter((best) => best.window === window);
    if (points.length === 0) return [];
    const values = points
      .map((best) => `${durationLabel(best.duration_s)} ${best.bpm} bpm`)
      .join(", ");
    return [`${label} ${values}`];
  });
  return parts.length > 0 ? `Heart rate bests: ${parts.join("; ")}.` : null;
}

/**
 * The text reply: settings first, then the heart rate bests and the two
 * checks. A line whose data is absent is left out. A swim group's paces read
 * per 100 m. Exported for direct testing.
 */
export function formatAthleteZonesText(response: AthleteZonesResponse): string {
  const lines: string[] = [
    response.default_group
      ? `${response.sport} zones and thresholds (intervals.icu's default Other group)`
      : `${response.sport} zones and thresholds (settings group: ${response.settings_types.join(", ")})`,
    ...response.warnings,
  ];

  const lthr = response.lthr_bpm;
  const maxHr = response.max_hr_bpm;
  const nothingSet =
    lthr === null &&
    maxHr === null &&
    response.hr_zones.length === 0 &&
    response.threshold_speed_mps === null &&
    response.pace_zones.length === 0 &&
    response.ftp_watts === null;
  if (nothingSet) {
    lines.push(
      "No thresholds or zones are set for this sport in intervals.icu.",
    );
  }

  if (lthr !== null || maxHr !== null) {
    const bpm = (value: number | null) =>
      value === null ? "not set" : `${value} bpm`;
    lines.push(`LTHR ${bpm(lthr)}, max HR ${bpm(maxHr)}.`);
  }

  if (response.hr_zones.length > 0) {
    lines.push(
      "HR zones (a heart rate is in the first zone whose upper bound is at or above it):",
    );
    for (const zone of response.hr_zones) {
      const range = hrZoneRangeText(
        { min: zone.min_bpm, max: zone.max_bpm },
        " bpm",
      );
      lines.push(`  Z${zone.zone}${zoneName(zone.name)}: ${range}`);
    }
  }

  const swim = coversSwim(response.settings_types);
  const speed = response.threshold_speed_mps;
  if (speed !== null) {
    const pace =
      swim && response.threshold_pace_min_per_100m
        ? `${response.threshold_pace_min_per_100m} /100m`
        : `${response.threshold_pace_min_per_km} /km`;
    lines.push(`Threshold pace ${pace} (${speed} m/s).`);
  }

  if (response.pace_zones.length > 0) {
    lines.push(
      speed === null
        ? "Pace zones (% of threshold speed; no threshold pace is set):"
        : "Pace zones (% of threshold speed):",
    );
    for (const zone of response.pace_zones) {
      lines.push(paceZoneLine(zone, swim));
    }
  }

  if (response.ftp_watts !== null) lines.push(`FTP ${response.ftp_watts} W.`);

  const bests = hrBestsLine(response.hr_bests);
  if (bests) lines.push(bests);
  lines.push(`LTHR check: ${response.threshold_checks.lthr.message}`);
  lines.push(`Max HR check: ${response.threshold_checks.max_hr.message}`);

  if (response.other_groups.length > 0) {
    const others = response.other_groups
      .map((types) => types.join(", "))
      .join("; ");
    lines.push(`Other settings groups: ${others}.`);
  }

  return lines.join("\n");
}

export const getAthleteZonesTool = {
  name,
  title: "Zones and thresholds",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: AthleteZonesOutputSchema,
  execute: async (
    { sport }: GetAthleteZonesInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress("Fetching sport settings");
      const groups = await listSportSettings(apiKey);
      const resolved = resolveSportGroup(groups, sport);
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: prefixedErrorText(noGroupText(groups, sport)),
            },
          ],
          isError: true,
        };
      }

      const hrCurve = await readHrCurves(apiKey, resolved, progress);
      const response = buildAthleteZones(groups, resolved, hrCurve);
      warnOnSchemaDrift(name, AthleteZonesOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatAthleteZonesText(response) },
        ],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: "fetch sport settings",
              notFound: "No sport settings were found for this athlete.",
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
