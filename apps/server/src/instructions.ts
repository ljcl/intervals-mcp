/**
 * The server's MCP `instructions`, served in `server/discover` (#38). A host
 * gives them to the model at the start of every chat, so each chat starts
 * oriented without the athlete uploading anything.
 *
 * docs/Intervals_MCP_Server.md is the long form. This is the short form: which
 * tool to call first, how to route fitness questions, and the rules that give
 * wrong answers or unsafe writes when a model does not know them. Keep it
 * under 1,800 characters with the longest time zone name (32 characters);
 * `server.integration.test.ts` checks the cap and that every tool it names
 * exists.
 */
export function serverInstructions(timeZone: string): string {
  return [
    "Intervals Extra reads one athlete's intervals.icu data. Its writes are update-activity, update-wellness and update-gear.",
    "",
    'Get activity ids from list-activities (e.g. "i189807578"), or pass id "latest" for the most recent run. Pass ids as quoted strings, never numbers: a large number loses digits.',
    "",
    "For one run, call get-running-summary first. Then use get-split-analysis for pacing, get-hill-analysis for climbs, get-interval-analysis for a workout, get-aerobic-analysis for decoupling on a steady run. To compare two runs, use compare-activities. For other sports, use get-activity.",
    "",
    "For fitness questions, use get-fitness-trend for freshness, fatigue or a taper plan; get-training-load for weekly volume and spike flags; get-athlete-stats for totals this week, month or year; get-wellness for HRV, resting heart rate and sleep (view-wellness for a chart); get-best-efforts and get-race-prediction for race times; get-athlete-zones for zones and thresholds.",
    "",
    "For where to run, use suggest-run-route, or view-route-suggestions for a map. To build or change a route: stitch-route, amend-route.",
    "",
    "A view-* tool opens a chart for the athlete; its result has the chart's numbers too, so no second call is needed.",
    "",
    "get-fitness-trend and get-training-load use whole-body load from every sport by default; runOnly: true gives a run-only series. Never mix the two, and say which one each number is.",
    "",
    `Units: km (m where the field name says so), pace as m:ss per km, heart rate in bpm. Dates are YYYY-MM-DD. Today and default ranges use the configured time zone, ${timeZone}.`,
    "",
    'Before a write, show the athlete the exact change and wait for a yes. To add a note, use descriptionMode or commentsMode "append". If a write may already have applied, re-read before retrying.',
  ].join("\n");
}
