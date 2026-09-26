/**
 * The server's MCP `instructions`, served in `server/discover` (#38). A host
 * gives them to the model at the start of every chat, so each chat starts
 * oriented without the athlete uploading anything.
 *
 * docs/Intervals_MCP_Server.md is the long form. This is the short form: which
 * tool to call first, how to route fitness questions, and the rules that give
 * wrong answers or unsafe writes when a model does not know them. Keep it
 * under 1,800 characters; `server.integration.test.ts` checks the cap and that
 * every tool it names exists.
 */
export function serverInstructions(timeZone: string): string {
  return [
    "Intervals Extra reads one athlete's intervals.icu data. update-activity is its only write.",
    "",
    'Get activity ids from list-activities (for example "i189807578"). Always pass an id as a quoted string, never as a number: a large number can lose digits.',
    "",
    "For one run, call get-running-summary first. Then choose the analysis that fits the run: get-split-analysis for pacing, get-hill-analysis for climbs, get-interval-analysis for a workout, get-aerobic-analysis for decoupling on a steady run. To compare two runs, use compare-activities. For other sports, use get-activity.",
    "",
    "For fitness questions, use get-fitness-trend for freshness, fatigue or a taper plan; get-training-load for weekly volume and injury-risk flags; get-athlete-stats for run totals this week, month or year; get-wellness for HRV, resting heart rate and sleep; get-best-efforts and get-race-prediction for race times.",
    "",
    "A view-* tool opens a chart for the athlete. For numbers in your reply, call the matching text tool, for example get-fitness-trend for view-fitness-trend.",
    "",
    "get-fitness-trend and get-training-load use whole-body load from every sport by default; runOnly: true gives a separate run-only series. Never mix whole-body and run-only numbers in one comparison, and say which one each number is.",
    "",
    `Units: distance in km (m where the field name says so), pace as m:ss per km, heart rate in bpm. Dates are YYYY-MM-DD. Today and the default date ranges use the configured time zone, ${timeZone}.`,
    "",
    'update-activity: show the athlete the exact change and wait for a yes before you call it. To add a note, use descriptionMode "append" so the existing description stays. If it says the update may already have been applied, check with get-activity before you try again.',
  ].join("\n");
}
