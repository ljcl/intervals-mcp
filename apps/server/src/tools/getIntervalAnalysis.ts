import { z } from "zod";
import {
  activityDisplayName,
  formatDuration,
  formatSigned,
} from "../formatters";
import {
  computeIntervalAnalysis,
  type IntervalAnalysis,
  IntervalAnalysisError,
  type IntervalLap,
  type IntervalStreams,
  repsFromLaps,
} from "../intervalAnalysis";
import { cadenceUnit } from "../intervalLaps";
import {
  pickCandidates,
  type RepStructure,
  SEARCH_LIMIT,
  SIMILAR_CANDIDATES_MAX,
  SIMILAR_SESSIONS_MAX,
  type SimilarSearchBand,
  sameRepStructure,
  similarSearchBand,
  summariseTypicalReps,
  typicalReps,
} from "../intervalSimilarity";
import {
  getActivitiesByIds,
  getActivity,
  type IntervalsActivity,
  type IntervalsInterval,
  searchActivitiesByIntervals,
} from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { cadenceSpm, formatPaceSeconds } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { noteToolFailure, toolErrorText, unavailableReason } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import {
  IntervalAnalysisOutputSchema,
  type SimilarSessionsOutput,
  warnOnSchemaDrift,
} from "./outputs";

const name = "get-interval-analysis";

const description = `
Decides whether one activity was an interval session and analyses its reps:
pace, HR, cadence and power per rep, fade across reps, and a verdict with a
confidence and a reasoning trail. Use it for "how did my intervals go?" or
"was this a workout at all?". With findSimilar it also compares the reps
with earlier sessions of the same structure: "am I getting faster at my 1 km
repeats?".

For laps exactly as recorded, use get-activity-laps; for continuous pacing,
get-split-analysis.

Notes:
- Clean intervals.icu laps (icu_intervals) are preferred, and they also catch
  jog-recovery sessions. Consecutive fast laps make one rep, and it takes 2
  reps with slower laps between them. Sliver laps (under 50 m or 15 s) are
  ignored. A slow warm-up or cool-down lap next to the first or last rep is
  not part of a rep; a last rep much slower than the others is dropped the same
  way. Laps that fail a consistency check fall back to the
  streams. On 1 km or 1 mile auto-laps a fast lap is often a downhill km, so
  they need matching WORK/RECOVERY labels or 3 clearly faster reps.
- In the streams, stops are classified before they count: under 60 s with no
  fast effort before it is a traffic light (ignored), up to 3 min after a
  fast effort is a recovery, over 5 min is a long stop (ignored). A stop
  before any movement is a standing start (ignored).
- Stream-based detection only sees rests where you stopped, so a
  jog-recovery workout needs laps.
- The HR signal measures time at 88% or more of the athlete's max HR
  (athlete_max_hr, else the top HR zone bound), not the run's own peak.
- findSimilar finds candidates with intervals.icu's interval search, then
  checks each one from its own laps. A session whose laps show no clean reps
  is skipped, even if it was a real workout.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id to analyse."),
  findSimilar: z
    .boolean()
    .default(false)
    .describe(
      "Also find up to 5 earlier sessions of the same sport with the same reps (typical rep time within 15%, similar rep count, similar interval intensity) and compare their rep pace and HR with this session's. Default false.",
    ),
});

type GetIntervalAnalysisInput = z.infer<typeof inputSchema>;

const STREAM_TYPES = [
  "time",
  "distance",
  "heartrate",
  "velocity_smooth",
  "cadence",
  "watts",
] as const;

/** Bare `m:ss`, no unit suffix; the structured field name (`*_min_per_km`)
 * carries the unit, `formatPaceSeconds` is the one home for the rendering. */
const paceMinPerKm = (secPerKm: number | null) =>
  secPerKm == null ? null : formatPaceSeconds(secPerKm);

/**
 * Thin adapter from one `icu_intervals` entry to the module's lap input.
 * Deliberately reads raw fields directly (distance, moving_time,
 * average_speed, average_cadence) rather than going through
 * `mapIntervalsToLaps`: that mapper's `LapEntry.average_cadence` is already
 * doubled to steps/min for a step-cadence type (display-ready), while
 * `intervalAnalysis.ts` averages/fades cadence in its raw per-leg form and
 * expects the controller to convert once for display (`cadenceSpm` below,
 * matching `getHillAnalysis.ts`'s convention). Reusing the doubled value
 * here would double-convert it for the lap path only.
 */
function toIntervalLap(
  interval: IntervalsInterval,
  index: number,
): IntervalLap {
  return {
    lapIndex: index + 1,
    distanceM: interval.distance ?? 0,
    movingTimeS: interval.moving_time ?? 0,
    avgSpeedMs: interval.average_speed ?? null,
    avgHr: interval.average_heartrate ?? null,
    avgCadence: interval.average_cadence ?? null,
    avgWatts: interval.average_watts ?? null,
    type: interval.type ?? null,
    intensity: interval.intensity ?? null,
  };
}

const MAX_HR_SOURCE_TEXT = {
  athlete_max_hr: "athlete max HR",
  hr_zones: "top HR zone bound",
  activity_peak: "this run's own peak",
} as const;

type RepStructureOutput = NonNullable<SimilarSessionsOutput["this_session"]>;
type SimilarSearchOutput = NonNullable<SimilarSessionsOutput["search"]>;

const NOT_INTERVALS_REASON =
  "This activity is not an interval session, so there are no reps to search for.";
const MIXED_REPS_REASON =
  "The reps differ in length (for example a pyramid), so there is no single rep length to search for.";

function toRepStructureOutput(structure: RepStructure): RepStructureOutput {
  return {
    rep_count: structure.repCount,
    rep_time_s: structure.repTimeS,
    rep_distance_m: structure.repDistanceM,
    pace_sec_per_km: structure.paceSecPerKm,
    pace_min_per_km: paceMinPerKm(structure.paceSecPerKm),
    avg_hr: structure.avgHr,
    intensity_pct: structure.intensityPct,
    pace_drift_pct: structure.paceDriftPct,
    hr_drift_bpm: structure.hrDriftBpm,
  };
}

function toSearchOutput(band: SimilarSearchBand): SimilarSearchOutput {
  return {
    rep_time_min_s: band.minSecs,
    rep_time_max_s: band.maxSecs,
    intensity_min_pct: band.intensityUsed ? band.minIntensity : null,
    intensity_max_pct: band.intensityUsed ? band.maxIntensity : null,
    rep_count_min: band.minReps,
    rep_count_max: band.maxReps,
  };
}

/** `a - b`, or null when either is missing. */
const difference = (a: number | null, b: number | null) =>
  a != null && b != null ? a - b : null;

/** "1 <singular>", else "N <plural>". */
const counted = (n: number, singular: string, plural: string) =>
  `${n} ${n === 1 ? singular : plural}`;

/** The band as text: "reps of 225-309 s at 92-107% intensity, 3-7 reps". */
function bandText(search: SimilarSearchOutput): string {
  const intensity =
    search.intensity_min_pct != null && search.intensity_max_pct != null
      ? `at ${search.intensity_min_pct}-${search.intensity_max_pct}% intensity`
      : "at any intensity";
  return `reps of ${search.rep_time_min_s}-${search.rep_time_max_s} s ${intensity}, ${search.rep_count_min}-${search.rep_count_max} reps`;
}

/**
 * Finds earlier sessions with the same reps as `analysis` (#84). It
 * searches only when this session has 2 or more typical reps. intervals.icu's
 * interval search gives the candidates, one bulk read gives their laps, and
 * each candidate is checked with the lap rules of the main analysis
 * (`repsFromLaps`). A failed search or bulk read degrades to `unavailable`
 * with the typed cause: the main analysis is complete, and it is what the
 * athlete asked for first.
 */
async function findSimilarSessions(
  apiKey: string,
  source: { id: string; type: string; startDateLocal: string },
  analysis: IntervalAnalysis,
  progress: ReportProgress,
): Promise<SimilarSessionsOutput> {
  const empty = {
    this_session: null,
    search: null,
    candidates: 0,
    checked: 0,
    skipped: { no_clean_reps: 0, different_reps: 0 },
    sessions: [],
  };
  if (!analysis.isIntervals) {
    return { ...empty, status: "not_intervals", reason: NOT_INTERVALS_REASON };
  }
  const typical = typicalReps(analysis.reps);
  if (typical.length < 2) {
    return { ...empty, status: "mixed_reps", reason: MIXED_REPS_REASON };
  }

  const thisSession = summariseTypicalReps(typical);
  const band = similarSearchBand(typical);
  const searched = {
    ...empty,
    this_session: toRepStructureOutput(thisSession),
    search: toSearchOutput(band),
  };
  const unavailable = (
    error: unknown,
    what: string,
    candidates: number,
  ): SimilarSessionsOutput => {
    // The operator log keeps the raw message; the athlete gets the typed cause.
    console.error(
      `Error while trying to find sessions like activity ${source.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ...searched,
      status: "unavailable",
      reason: `${what}: ${unavailableReason(error)}.`,
      candidates,
    };
  };

  progress("Searching intervals.icu for sessions with the same reps");
  let rows: IntervalsActivity[];
  try {
    rows = await searchActivitiesByIntervals(apiKey, band);
  } catch (error) {
    return unavailable(error, "The interval search failed", 0);
  }
  const { candidates } = pickCandidates(rows, source);
  const pageFull = rows.length >= SEARCH_LIMIT;
  const toRead = candidates.slice(0, SIMILAR_CANDIDATES_MAX);
  if (toRead.length === 0) {
    const intensity = band.intensityUsed
      ? ` at ${band.minIntensity}-${band.maxIntensity}% intensity`
      : "";
    return {
      ...searched,
      status: "none_found",
      reason: pageFull
        ? `The ${SEARCH_LIMIT} newest matches that intervals.icu returned were all later sessions or other sports, so older sessions were not searched (${band.minReps}-${band.maxReps} reps of ${band.minSecs}-${band.maxSecs} s${intensity}).`
        : `intervals.icu found no earlier session of the same sport with ${band.minReps}-${band.maxReps} reps of ${band.minSecs}-${band.maxSecs} s${intensity}.`,
    };
  }

  progress(`Reading ${toRead.length} candidate sessions`);
  const byId = new Map<string, IntervalsActivity>();
  try {
    const activities = await getActivitiesByIds(
      apiKey,
      toRead.map((row) => row.id),
      { intervals: true },
    );
    for (const activity of activities) byId.set(activity.id, activity);
  } catch (error) {
    return unavailable(
      error,
      "The candidate sessions could not be read",
      candidates.length,
    );
  }

  const sessions: SimilarSessionsOutput["sessions"] = [];
  const skipped = { no_clean_reps: 0, different_reps: 0 };
  let checked = 0;
  for (const row of toRead) {
    if (sessions.length >= SIMILAR_SESSIONS_MAX) break;
    // Deleted between the two reads: the bulk read drops it with no error.
    const activity = byId.get(row.id);
    if (!activity) continue;
    checked++;
    const reps = repsFromLaps(
      (activity.icu_intervals ?? []).map(toIntervalLap),
    );
    if (!reps) {
      skipped.no_clean_reps++;
      continue;
    }
    const candidateTypical = typicalReps(reps);
    const structure =
      candidateTypical.length >= 2
        ? summariseTypicalReps(candidateTypical)
        : null;
    if (!structure || !sameRepStructure(structure, thisSession)) {
      skipped.different_reps++;
      continue;
    }
    sessions.push({
      activity_id: activity.id,
      name: activityDisplayName(activity),
      date: activity.start_date_local,
      type: activity.type ?? "Workout",
      ...toRepStructureOutput(structure),
      pace_delta_sec_per_km: difference(
        structure.paceSecPerKm,
        thisSession.paceSecPerKm,
      ),
      hr_delta_bpm: difference(structure.avgHr, thisSession.avgHr),
    });
  }

  const counts = { candidates: candidates.length, checked, skipped };
  if (sessions.length > 0) {
    return { ...searched, ...counts, status: "found", reason: null, sessions };
  }
  const notChecked = candidates.length - checked;
  const more =
    notChecked > 0
      ? ` ${counted(notChecked, "older candidate was", "older candidates were")} not checked, so ${candidates.length} were found in all.`
      : "";
  const why = `${counted(skipped.no_clean_reps, "shows no clean reps", "show no clean reps")}, ${counted(skipped.different_reps, "has different reps", "have different reps")}`;
  return {
    ...searched,
    ...counts,
    status: "none_found",
    reason:
      checked === 0
        ? "The earlier sessions that intervals.icu found could not be read."
        : checked === 1
          ? `The 1 earlier session that intervals.icu found does not have the same reps in its laps (${why}).${more}`
          : `None of the ${checked} earlier sessions that intervals.icu found has the same reps in its laps (${why}).${more}`,
  };
}

/** "last rep 5% faster", "even pace", or null with no pace drift. */
function driftText(paceDriftPct: number | null): string | null {
  if (paceDriftPct == null) return null;
  if (paceDriftPct === 0) return "even pace";
  return `last rep ${Math.abs(paceDriftPct)}% ${paceDriftPct > 0 ? "slower" : "faster"}`;
}

/** One line of the similar block: the parts that are present, comma-joined. */
const joinParts = (parts: Array<string | null>) =>
  parts.filter((part): part is string => part != null).join(", ");

/** The text block for `similar`, after the HR signal line. */
function similarLines(
  similar: SimilarSessionsOutput,
  sourceDate: string,
): string[] {
  const mine = similar.this_session;
  if (similar.status !== "found" || !mine || !similar.search) {
    const label = similar.status === "unavailable" ? "unavailable" : "none";
    return [`Similar earlier sessions: ${label}. ${similar.reason ?? ""}`];
  }

  const pace = (structure: RepStructureOutput) =>
    structure.pace_min_per_km != null
      ? `${structure.pace_min_per_km} /km`
      : "no pace";
  const lines = [
    `Similar earlier sessions (typical rep: ${mine.rep_distance_m} m in ${formatDuration(mine.rep_time_s)}, ${counted(mine.rep_count, "rep", "reps")}):`,
    `  ${joinParts([
      `This session ${sourceDate.slice(0, 10)}: ${mine.rep_count} × ${mine.rep_distance_m} m at ${pace(mine)}`,
      mine.avg_hr != null ? `${mine.avg_hr} bpm` : "no HR",
      driftText(mine.pace_drift_pct),
    ])}`,
  ];
  for (const session of similar.sessions) {
    const paceDiff =
      session.pace_delta_sec_per_km != null
        ? ` (${formatSigned(session.pace_delta_sec_per_km)} s/km)`
        : "";
    const hrDiff =
      session.hr_delta_bpm != null
        ? ` (${formatSigned(session.hr_delta_bpm)})`
        : "";
    lines.push(
      `  ${joinParts([
        `${session.date.slice(0, 10)} ${session.name} (${session.activity_id}): ${session.rep_count} × ${session.rep_distance_m} m at ${pace(session)}${paceDiff}`,
        session.avg_hr != null ? `${session.avg_hr} bpm${hrDiff}` : "no HR",
        driftText(session.pace_drift_pct),
      ])}`,
    );
  }
  lines.push(
    "  In brackets: the change against this session; + is slower pace or higher HR.",
  );
  // Older candidates once 5 matched or past the read cap, and any candidate
  // deleted between the search and the bulk read.
  const notChecked = similar.candidates - similar.checked;
  const tally = [
    counted(similar.sessions.length, "matches", "match"),
    counted(
      similar.skipped.no_clean_reps,
      "shows no clean reps in its laps",
      "show no clean reps in their laps",
    ),
    counted(
      similar.skipped.different_reps,
      "has different reps",
      "have different reps",
    ),
  ].join(", ");
  lines.push(
    `  Checked ${similar.checked} of ${similar.candidates} earlier sessions that intervals.icu found (${bandText(similar.search)}): ${tally}.${notChecked > 0 ? ` ${counted(notChecked, "candidate was", "candidates were")} not checked.` : ""}`,
  );
  return lines;
}

export const getIntervalAnalysisTool = {
  name,
  title: "Interval analysis",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: IntervalAnalysisOutputSchema,
  execute: async (
    { id, findSimilar }: GetIntervalAnalysisInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivity(apiKey, id, { intervals: true });
      const type = activity.type ?? "Workout";
      const displayName = activity.name ?? type;

      progress(`Fetching streams for "${displayName}"`);
      let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
      try {
        streams = await loadIntervalsStreams(apiKey, id, [...STREAM_TYPES]);
      } catch (error) {
        if (error instanceof IntervalsStreamsUnavailableError) {
          noteToolFailure(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ No data streams are recorded for "${displayName}" (activity ${id}): manual activities have no recorded samples to analyse.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      progress("Computing interval analysis", { important: true });
      const intervalStreams: IntervalStreams = {
        time: streams.time,
        distance: streams.distance ?? [],
        moving: streams.moving,
        heartrate: streams.heartrate,
        cadence: streams.cadence,
        watts: streams.watts,
      };
      const laps = (activity.icu_intervals ?? []).map(toIntervalLap);
      const analysis = computeIntervalAnalysis(intervalStreams, laps, {
        athleteMaxHr: activity.athlete_max_hr,
        hrZones: activity.icu_hr_zones,
      });
      const cadenceUnitLabel = cadenceUnit(type);
      const similar = findSimilar
        ? await findSimilarSessions(
            apiKey,
            // The API's own `i`-prefixed id, as the search rows carry it: the
            // `id` input may be bare digits.
            {
              id: activity.id,
              type,
              startDateLocal: activity.start_date_local,
            },
            analysis,
            progress,
          )
        : undefined;

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        is_intervals: analysis.isIntervals,
        source: analysis.source,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        reps: analysis.reps.map((rep) => ({
          index: rep.index,
          start_km: rep.startKm,
          distance_m: rep.distanceM,
          moving_time_s: rep.movingTimeS,
          moving_time_formatted: formatDuration(rep.movingTimeS),
          pace_sec_per_km: rep.paceSecPerKm,
          pace_min_per_km: paceMinPerKm(rep.paceSecPerKm),
          avg_hr: rep.avgHr,
          avg_cadence: cadenceSpm(rep.avgCadence, type),
          avg_watts: rep.avgWatts,
          intensity_pct: rep.intensityPct,
        })),
        rests: analysis.rests.map((rest) => ({
          start_time_s: rest.startTimeS,
          at_km: rest.atKm,
          duration_s: rest.durationS,
          kind: rest.kind,
          reason: rest.reason,
        })),
        fade: analysis.fade
          ? {
              pace_drift_pct: analysis.fade.paceDriftPct,
              hr_drift_bpm: analysis.fade.hrDriftBpm,
              cadence_drift_pct: analysis.fade.cadenceDriftPct,
              summary: analysis.fade.summary,
            }
          : null,
        hr_signal: analysis.hrSignal
          ? {
              max_hr: analysis.hrSignal.maxHr,
              max_hr_source: analysis.hrSignal.maxHrSource,
              high_intensity_share_pct:
                Math.round(analysis.hrSignal.highIntensityShare * 1000) / 10,
              assessment: analysis.hrSignal.assessment,
            }
          : null,
        units: {
          distance: "km" as const,
          pace: "min/km" as const,
          time: "s" as const,
          hr: "bpm" as const,
          cadence: cadenceUnitLabel,
          power: "W" as const,
        },
        warnings: analysis.warnings,
        ...(similar ? { similar } : {}),
      };
      warnOnSchemaDrift(name, IntervalAnalysisOutputSchema, structured);

      const lines = [
        `Interval Analysis: ${structured.name} (${structured.date})`,
        structured.is_intervals
          ? `Verdict: interval session, ${structured.reps.length} work reps (confidence: ${structured.confidence})`
          : `Verdict: not an interval session (confidence: ${structured.confidence})`,
        `Reasoning: ${structured.reasoning}`,
        "",
      ];

      if (structured.reps.length > 0) {
        lines.push("Reps:");
        for (const rep of structured.reps) {
          const parts = [
            `${rep.distance_m} m in ${rep.moving_time_formatted}`,
            rep.pace_min_per_km ? `${rep.pace_min_per_km} /km` : null,
            rep.avg_hr != null ? `${rep.avg_hr} bpm` : null,
            rep.avg_cadence != null
              ? `${rep.avg_cadence} ${cadenceUnitLabel}`
              : null,
            rep.avg_watts != null ? `${rep.avg_watts} W` : null,
          ].filter(Boolean);
          lines.push(`  ${rep.index}. km ${rep.start_km}: ${parts.join(", ")}`);
        }
        lines.push("");
      }

      if (structured.fade) {
        lines.push(`Fade: ${structured.fade.summary}`, "");
      }

      if (structured.rests.length > 0) {
        lines.push("Rests:");
        for (const rest of structured.rests) {
          lines.push(`  km ${rest.at_km}: ${rest.reason}`);
        }
        lines.push("");
      }

      if (structured.hr_signal) {
        lines.push(
          `HR signal: ${structured.hr_signal.assessment} (${structured.hr_signal.high_intensity_share_pct}% of moving time at ≥88% of ${structured.hr_signal.max_hr} bpm, ${MAX_HR_SOURCE_TEXT[structured.hr_signal.max_hr_source]})`,
        );
      }

      if (similar) {
        if (lines[lines.length - 1] !== "") lines.push("");
        lines.push(...similarLines(similar, structured.date));
      }

      for (const warning of structured.warnings) {
        lines.push(`Warning: ${warning}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof IntervalAnalysisError) {
        noteToolFailure(error);
        return {
          content: [{ type: "text" as const, text: `❌ ${error.message}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `compute interval analysis for activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
