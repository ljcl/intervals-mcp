import { z } from "zod";
import { getTimeZone } from "../config";
import { formatDuration, round } from "../formatters";
import { getAthletePaceCurves } from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  buildSplits,
  type CriticalSpeedModel,
  CS_MODEL_MAX_SECONDS,
  CS_MODEL_MIN_SECONDS,
  criticalSpeedModel,
  criticalSpeedPredict,
  formatRaceTime,
  isWithinCriticalSpeedValidity,
  NEGATIVE_SPLIT_PCT,
  paceCurveSourceEfforts,
  parseGoalTime,
  predictRace,
  RACE_DISTANCES,
  type RaceDistanceName,
  racePace,
  type SourceEffort,
  type SplitPlan,
  STANDARD_TARGETS,
  selectSourceEfforts,
} from "../racePrediction";
import { todayLocal } from "../utils/localDate";
import { formatPaceSeconds } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { RacePredictionOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-race-prediction";

const description = `
Predicts race times from intervals.icu's pace curves and builds a goal-pace split table.

Uses Riegel's equivalent-performance formula (T2 = T1 x (D2/D1)^1.06) over pace-curve
points (the fastest ever, and the fastest of the last 90 days, at each recorded
distance), combined into one estimate per distance weighted by how recent each
point is and how far it has to be extrapolated.

Alongside each Riegel estimate, reports intervals.icu's own critical-speed model
fit to the same pace curve: time = (distance - dPrime) / criticalSpeed. That model
is stated as valid for roughly 3 to 60 minutes of racing; a prediction outside
that range (a marathon, for instance) is still shown, flagged as outside the
model's validity rather than hidden.

Use Cases:
- "I am racing a half in six weeks, what should I target, and what is my km split?"
- Sanity-check a goal time against what your training actually supports
- See which pace-curve point is driving a prediction, and how the two models compare

Parameters:
- raceDistance (optional): the race you are planning ("5K", "10K", "15K", "10 mile",
  "Half Marathon", "Marathon", "50K"). Supply it to get the split table; omit it
  for the equivalent-performance table alone
- goalTime (optional): pace the splits to your own goal instead of the prediction
  ("1:45:00", "45:30", "1h45m"). Requires raceDistance

Notes:
- Riegel is an extrapolation, not a measurement. Every prediction carries a
  confidence grade, the pace-curve point that drives it, and the spread across sources
- Pace-curve points under 1500 m are excluded from Riegel's inputs, outside the
  range the formula fits
- The critical-speed model comes from the athlete's "90d" pace curve (current
  fitness), falling back to the "all" curve when "90d" carries no fit
- It assumes appropriate training for the distance; it cannot know whether you
  have done the long runs a marathon needs
`;

/** ISO date-time-agnostic goal time input, still free text so runners can
 * write it however they naturally would ("1:45:00", "45:30", "1h45m"). */
const inputSchema = z.object({
  raceDistance: z
    .enum(
      Object.keys(RACE_DISTANCES) as [RaceDistanceName, ...RaceDistanceName[]],
    )
    .optional()
    .describe(
      "The race being planned. Supply it to get a km split table; omit for predictions only.",
    ),
  goalTime: z
    .string()
    .optional()
    .describe(
      "Pace the splits to this target instead of the prediction ('1:45:00', '45:30', '1h45m'). Needs raceDistance.",
    ),
});

type GetRacePredictionInput = z.infer<typeof inputSchema>;

/**
 * Flat `pace_sec_per_km`/`pace_min_per_km` fields (bare `m:ss`, no unit
 * suffix), matching every other tool's pace convention rather than this
 * tool's former nested `pace: { min_per_km }` object. Null fields (not an
 * "N/A" sentinel) when either input is non-positive.
 */
function paceFields(
  seconds: number,
  distanceMeters: number,
): { pace_sec_per_km: number | null; pace_min_per_km: string | null } {
  if (!(seconds > 0) || !(distanceMeters > 0)) {
    return { pace_sec_per_km: null, pace_min_per_km: null };
  }
  const secPerKm = (seconds / distanceMeters) * 1000;
  return {
    pace_sec_per_km: round(secPerKm, 2),
    pace_min_per_km: formatPaceSeconds(secPerKm),
  };
}

const serializeSource = (source: SourceEffort) => ({
  name: source.name,
  distance_m: Math.round(source.distanceMeters * 10) / 10,
  time_seconds: source.elapsedSeconds,
  time_formatted: formatDuration(source.elapsedSeconds),
  date: source.date,
  activity_id: source.activityId,
  activity_name: source.activityName,
});

const UNITS = {
  distance: "m" as const,
  pace: "min/km" as const,
  time: "s" as const,
};

/** The critical-speed prediction for one target distance, or `null` when no
 * model is available or the target does not exceed the model's `dPrime`. */
function criticalSpeedPrediction(
  model: CriticalSpeedModel | null,
  targetMeters: number,
) {
  if (!model) return null;
  const seconds = criticalSpeedPredict(model, targetMeters);
  if (seconds === null) return null;
  const rounded = Math.round(seconds);
  return {
    predicted_seconds: rounded,
    predicted_formatted: formatRaceTime(rounded),
    ...paceFields(seconds, targetMeters),
    within_model_range: isWithinCriticalSpeedValidity(seconds),
  };
}

const serializeSplitPlan = (plan: SplitPlan) => ({
  unit: plan.unit,
  strategy:
    plan.negativeSplitPct > 0 ? ("negative" as const) : ("even" as const),
  negative_split_pct: plan.negativeSplitPct,
  total_seconds: plan.totalSeconds,
  total_formatted: formatRaceTime(plan.totalSeconds),
  splits: plan.splits.map((split) => ({
    index: split.index,
    cumulative_m: split.cumulativeMeters,
    segment_m: split.segmentMeters,
    split_seconds: split.splitSeconds,
    split_formatted: formatRaceTime(split.splitSeconds),
    cumulative_seconds: split.cumulativeSeconds,
    cumulative_formatted: formatRaceTime(split.cumulativeSeconds),
    pace_sec_per_km: round(split.paceSecPerUnit, 2),
    pace_min_per_km: formatPaceSeconds(split.paceSecPerUnit),
  })),
});

/**
 * Column header for `renderSplitTable`. Padded to line up with the rows it
 * emits: index+unit occupy 7 chars, split ends at 16, cumulative at 27.
 */
const SPLIT_TABLE_HEADER = `${" ".repeat(11)}split cumulative\n`;

/** Rows for one split table, aligned so the columns read as a table. */
function renderSplitTable(plan: SplitPlan): string {
  let out = "";
  for (const split of plan.splits) {
    const partial =
      split.segmentMeters < 999
        ? ` (${Math.round(split.segmentMeters)} m)`
        : "";
    out += `  ${String(split.index).padStart(2, " ")} km  ${formatRaceTime(
      split.splitSeconds,
    ).padStart(
      7,
      " ",
    )}   ${formatRaceTime(split.cumulativeSeconds).padStart(8, " ")}${partial}\n`;
  }
  return out;
}

export const getRacePredictionTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: RacePredictionOutputSchema,
  execute: async (
    { raceDistance, goalTime }: GetRacePredictionInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    // Reject a bad goal time before spending a request on it.
    const goalSeconds = goalTime !== undefined ? parseGoalTime(goalTime) : null;
    if (goalTime !== undefined && goalSeconds === null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Could not read "${goalTime}" as a race time. Use H:MM:SS ("1:45:00"), MM:SS ("45:30"), or shorthand ("1h45m").`,
          },
        ],
        isError: true,
      };
    }

    try {
      progress("Fetching pace curves (all, 90d)...", { important: true });
      const curves = await getAthletePaceCurves(apiKey, {
        type: "Run",
        curves: ["all", "90d"],
      });

      const allCurve = curves.list.find((c) => c.id === "all");
      const recentCurve = curves.list.find((c) => c.id === "90d");

      const efforts = paceCurveSourceEfforts(
        curves.activities,
        allCurve,
        recentCurve,
      );
      const referenceDate = todayLocal(getTimeZone());
      const sources = selectSourceEfforts(efforts, referenceDate);

      // Prefer the 90-day curve: it reflects current fitness, where "all"
      // can be dominated by a fit fading years ago. "all" only steps in
      // when the 90-day curve carries no usable CS fit (too few points).
      const csModelFromRecent = criticalSpeedModel(recentCurve);
      const csModel = csModelFromRecent ?? criticalSpeedModel(allCurve);
      const csModelSource: "90d" | "all" = csModelFromRecent ? "90d" : "all";

      const warnings: string[] = [];
      if (!allCurve && !recentCurve) {
        warnings.push(
          'Neither the "all" nor "90d" pace curve was returned by intervals.icu.',
        );
      }

      // The requested race joins the standard table when it is not already in it.
      const targetNames: RaceDistanceName[] = [...STANDARD_TARGETS];
      if (raceDistance && !targetNames.includes(raceDistance)) {
        targetNames.push(raceDistance);
      }
      targetNames.sort((a, b) => RACE_DISTANCES[a] - RACE_DISTANCES[b]);

      const predictions = targetNames
        .map((label) =>
          predictRace(sources, RACE_DISTANCES[label], label, referenceDate),
        )
        .filter((p) => p !== null);

      const method =
        "Riegel T2 = T1 x (D2/D1)^1.06 over intervals.icu pace-curve points (fastest ever and fastest of the last 90 days per distance), weighted by recency (90-day half-life) and extrapolation distance. Assumes training appropriate to the distance. The critical-speed prediction is intervals.icu's own model: time = (distance - dPrime) / criticalSpeed, stated as valid for roughly 3 to 60 minute efforts.";

      const criticalSpeedModelField = csModel
        ? {
            critical_speed_min_per_km: formatPaceSeconds(
              1000 / csModel.criticalSpeedMetersPerSec,
            ),
            d_prime_m: Math.round(csModel.dPrimeMeters * 10) / 10,
            r2: Math.round(csModel.r2 * 10000) / 10000,
            source: csModelSource,
          }
        : null;

      if (sources.length === 0) {
        const response = {
          predictions: [],
          target: null,
          sources: [],
          critical_speed_model: criticalSpeedModelField,
          units: UNITS,
          warnings: [
            ...warnings,
            "No recorded pace-curve points of 1500 m or longer were found.",
          ],
          method,
        };
        warnOnSchemaDrift(name, RacePredictionOutputSchema, response);

        let text = "Race prediction\n\n";
        text +=
          "Not enough to predict from. No recorded pace-curve points of 1500 m or longer were found.\n";
        for (const warning of response.warnings) text += `\n${warning}\n`;

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: response,
        };
      }

      // ---- target race: splits, paced to the goal when one was given ----
      let target: {
        distance: string;
        distance_m: number;
        basis: "goal" | "predicted";
        total_seconds: number;
        total_formatted: string;
        pace_sec_per_km: number | null;
        pace_min_per_km: string | null;
        goal_vs_predicted_seconds: number | null;
        goal_assessment: string | null;
        splits: ReturnType<typeof serializeSplitPlan>[];
      } | null = null;

      let targetPlans: SplitPlan[] = [];

      if (raceDistance) {
        const targetMeters = RACE_DISTANCES[raceDistance];
        const predicted = predictions.find((p) => p.label === raceDistance);
        const totalSeconds = goalSeconds ?? predicted?.predictedSeconds ?? 0;

        if (totalSeconds > 0) {
          targetPlans = [
            buildSplits(totalSeconds, targetMeters, "km"),
            buildSplits(totalSeconds, targetMeters, "km", NEGATIVE_SPLIT_PCT),
          ];

          const delta =
            goalSeconds !== null && predicted
              ? goalSeconds - predicted.predictedSeconds
              : null;
          let assessment: string | null = null;
          if (delta !== null && predicted) {
            const gap = Math.abs(delta);
            const pct = (gap / predicted.predictedSeconds) * 100;
            if (delta > 0 && pct >= 2) {
              assessment = `Your goal is ${formatRaceTime(gap)} slower than the ${formatRaceTime(predicted.predictedSeconds)} your efforts predict, a conservative target you should be able to hold.`;
            } else if (pct < 2) {
              assessment = `Your goal is within ${formatRaceTime(gap)} of the ${formatRaceTime(predicted.predictedSeconds)} predicted, right on what your efforts support.`;
            } else if (pct < 6) {
              assessment = `Your goal is ${formatRaceTime(gap)} faster than the ${formatRaceTime(predicted.predictedSeconds)} predicted (${pct.toFixed(1)}%), a stretch that needs the race to go right.`;
            } else {
              assessment = `Your goal is ${formatRaceTime(gap)} faster than the ${formatRaceTime(predicted.predictedSeconds)} predicted (${pct.toFixed(1)}%), well beyond what your recorded efforts support. Going out at this pace risks blowing up.`;
            }
          }

          target = {
            distance: raceDistance,
            distance_m: targetMeters,
            basis: goalSeconds !== null ? "goal" : "predicted",
            total_seconds: totalSeconds,
            total_formatted: formatRaceTime(totalSeconds),
            ...paceFields(totalSeconds, targetMeters),
            goal_vs_predicted_seconds: delta,
            goal_assessment: assessment,
            splits: targetPlans.map(serializeSplitPlan),
          };
        }
      }

      const response = {
        predictions: predictions.map((p) => ({
          distance: p.label,
          distance_m: p.distanceMeters,
          predicted_seconds: p.predictedSeconds,
          predicted_formatted: formatRaceTime(p.predictedSeconds),
          ...paceFields(p.predictedSeconds, p.distanceMeters),
          confidence: p.confidence,
          confidence_notes: p.confidenceNotes,
          primary_source: serializeSource(p.primary.source),
          spread: p.spread
            ? {
                fastest_seconds: p.spread.fastestSeconds,
                slowest_seconds: p.spread.slowestSeconds,
                range_seconds: p.spread.rangeSeconds,
                range_pct: p.spread.rangePct,
              }
            : null,
          contributions: p.contributions.map((c) => ({
            source: serializeSource(c.source),
            predicted_seconds: c.predictedSeconds,
            predicted_formatted: formatRaceTime(c.predictedSeconds),
            age_days: c.ageDays,
            weight: c.weight,
          })),
          critical_speed: criticalSpeedPrediction(csModel, p.distanceMeters),
        })),
        target,
        sources: sources.map(serializeSource),
        critical_speed_model: criticalSpeedModelField,
        units: UNITS,
        warnings,
        method,
      };

      // ---- text ----
      let output = "Race prediction\n";
      output += `${sources.length} pace-curve point${sources.length === 1 ? "" : "s"} used as inputs\n`;
      output += "\nEquivalent performances\n";
      for (const p of predictions) {
        const pace = racePace(p.predictedSeconds, p.distanceMeters);
        output += `  ${p.label.padEnd(14, " ")} ${formatRaceTime(p.predictedSeconds)}`;
        if (pace) output += `  (${pace.minPerKm} /km)`;
        output += ` [${p.confidence}]\n`;
        output += `     from ${p.primary.source.name} in ${formatDuration(p.primary.source.elapsedSeconds)} on ${p.primary.source.date}`;
        if (p.spread && p.spread.rangeSeconds > 0) {
          output += `; sources range ${formatRaceTime(p.spread.fastestSeconds)}-${formatRaceTime(p.spread.slowestSeconds)}`;
        }
        output += "\n";
        const cs = criticalSpeedPrediction(csModel, p.distanceMeters);
        if (cs) {
          output += `     critical speed: ${cs.predicted_formatted} (${cs.pace_min_per_km} /km)`;
          output += cs.within_model_range
            ? "\n"
            : " - outside the model's 3-60 minute validity window\n";
        }
      }

      output += "\nConfidence\n";
      for (const p of predictions) {
        output += `  ${p.label}: ${p.confidence}\n`;
        for (const note of p.confidenceNotes) {
          output += `     - ${note}\n`;
        }
      }

      if (csModel) {
        output += `\nCritical speed model (intervals.icu, ${csModelSource} curve)\n`;
        output += `  ${criticalSpeedModelField?.critical_speed_min_per_km} /km critical pace, dPrime ${Math.round(csModel.dPrimeMeters)} m, r2 ${csModel.r2.toFixed(3)}\n`;
        output += `  Valid for roughly ${CS_MODEL_MIN_SECONDS / 60}-${CS_MODEL_MAX_SECONDS / 60} minute efforts; predictions outside that range are shown above but flagged.\n`;
      }

      if (target) {
        const [kmPlan, negativePlan] = targetPlans;
        output += `\n${target.distance} target: ${target.total_formatted} `;
        output += target.basis === "goal" ? "(your goal)\n" : "(predicted)\n";
        output += `   ${target.pace_min_per_km} /km\n`;
        if (target.goal_assessment) {
          output += `   ${target.goal_assessment}\n`;
        }

        if (kmPlan) {
          output += "\nEven splits - kilometres\n";
          output += SPLIT_TABLE_HEADER;
          output += renderSplitTable(kmPlan);
        }
        if (negativePlan) {
          output += `\nNegative split (${(NEGATIVE_SPLIT_PCT * 100).toFixed(0)}% either side of halfway) - kilometres\n`;
          output += SPLIT_TABLE_HEADER;
          output += renderSplitTable(negativePlan);
        }
      } else {
        output +=
          "\nPass raceDistance to get a km split table (and goalTime to pace it to your own target).\n";
      }

      output += "\nInputs (pace-curve points used)\n";
      for (const source of sources) {
        output += `  ${source.name}: ${formatDuration(source.elapsedSeconds)} on ${source.date} - ${source.activityName}\n`;
      }

      for (const warning of warnings) {
        output += `\n${warning}\n`;
      }
      output += `\n${method}\n`;

      warnOnSchemaDrift(name, RacePredictionOutputSchema, response);

      return {
        content: [{ type: "text" as const, text: output }],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: "predict race times from pace curves",
              notFound: "No pace curve data was found for this athlete.",
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
