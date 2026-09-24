# Tool reference

Everything the server exposes: tools, prompts, permission behaviour, and
example requests. The single home for this catalog — README and AGENTS.md link
here instead of keeping copies.

Tool names and schemas are a published contract: grants are stored per tool
identity, so renames or schema reshapes re-prompt every user. See
[architecture.md](architecture.md#tool-metadata) before changing either.

## Activity tools

| Tool | Description |
| ---- | ----------- |
| `update-activity` | Update an activity's description, title, sport type, gear, or flags |
| `get-activity-zones` | Time spent in each HR and power zone for an activity |
| `get-activity-laps` | Laps of an activity with sport-aware pace/speed, HR, power, cadence |
| `export-activity-gpx` | Export an activity's recorded track as GPX built from its streams, inline or to a file |
| `get-running-summary` | Running-focused summary with HR zones and lap analysis |
| `get-aerobic-analysis` | Aerobic decoupling, efficiency factor, and intensity factor from HR + power/speed streams |
| `get-hill-analysis` | Climb/descent detection with GAP and early-vs-late climb effort drift |
| `get-split-analysis` | Even km/mile splits with a two-halves pacing verdict stated on the clock and grade-adjusted |
| `get-interval-analysis` | Interval detection with urban-stop-aware rest classification and rep fade |
| `get-training-load` | Training load summary with trend analysis |
| `get-fitness-trend` | Fitness/fatigue/form (CTL/ATL/TSB) from relative effort, with rest projection and a solved taper to a target form on a target date |
| `compare-activities` | Compare two running activities side-by-side |
| `get-best-efforts` | Personal best efforts across all running activities, optionally scoped to a date window |
| `get-race-prediction` | Predicted race times from recorded best efforts (Riegel), with confidence, source effort, and km/mile goal-pace splits |

## Athlete tools

| Tool | Description |
| ---- | ----------- |
| `get-athlete-stats` | Activity statistics (recent, YTD, all-time) |

## Visualization tools

Each `view-*` MCP App has an app-only `get-*-data` companion that fetches what
the UI renders.

| Tool | Description |
| ---- | ----------- |
| `view-activity-chart` | Interactive chart with HR, power, pace, altitude overlays (MCP App) |
| `get-activity-streams-raw` | Raw stream data for the activity chart UI (app-only) |
| `view-cadence-trends` | Interactive cadence trends with timeline, scatter, zones, and overlay views (MCP App) |
| `get-cadence-trend-data` | Summary cadence/pace data for the cadence trends UI (app-only) |
| `view-route-map` | Interactive map of an activity's GPS track, fit to bounds with start/finish markers; optional distance-anchored waypoints (MCP App) |
| `get-route-map-data` | Decoded `[lat, lng]` coordinates plus index-aligned metric streams for the route map UI (app-only) |
| `view-training-load` | Weekly running-volume bars with a rolling trend line and injury-risk warning weeks (MCP App) |
| `get-training-load-data` | Per-week volume, trend value, and warning flags for the training-load UI (app-only) |
| `view-compare-activities` | Interactive overlay of two activities' streams on a shared distance/time axis with a delta summary (MCP App) |
| `get-compare-activities-data` | Aggregate comparison (summaries, activity2−activity1 differences, efficiency) for the compare-activities UI (app-only) |
| `view-activity-zones` | Time-in-zone bar chart for one activity's HR and power zones with an easy/moderate/hard split (MCP App) |
| `get-activity-zones-data` | Per-zone time distributions (bucket bounds, seconds, percentages) for the activity-zones UI (app-only) |
| `view-fitness-trend` | CTL/ATL/TSB over time with shaded fatigue/freshness/ramp bands and a dashed taper plan or rest projection past today (MCP App) |
| `get-fitness-trend-data` | Per-day CTL/ATL/TSB, the projection, the solved taper, and the dated warning bands for the fitness-trend UI (app-only) |

## Prompts

Reusable multi-step workflows a host can offer as slash commands or starters.

| Prompt | Arguments | What it does |
| ------ | --------- | ------------ |
| `weekly-review` | `weeks` (optional, default 4) | Reviews recent training — load trend, key workouts, cadence patterns — ending with focus points for next week |
| `annotate-last-run` | `activity_id` (optional, defaults to the most recent run) | Analyses a run and appends a short coaching note to its Strava description. Confirms before writing |

In Claude Desktop and Claude Code these appear in the prompt picker once the
server is connected. `annotate-last-run` uses a write tool (`update-activity`),
so it needs the `activity:write` scope.

## Tool permissions

Every tool declares MCP annotations so a host can tell reads from writes. The
27 read tools set `readOnlyHint: true` and `destructiveHint: false`, which is
the combination clients use to offer a durable "always allow". Two tools are
writes and are expected to keep asking:

| Tool | Why it asks |
| ---- | ----------- |
| `update-activity` | Overwrites an existing activity's fields |
| `export-activity-gpx` | Returns the document in the response, or writes a file into `ROUTE_EXPORT_PATH` |

No tool sets `anthropic/requiresUserInteraction`, so nothing opts out of
"always allow" on purpose.

If a client re-prompts for read tools after you granted them, check whether the
server was upgraded to a version that renamed a tool or changed its input
schema — permission grants are stored per tool identity, so that drops the
grant. Releases that do this say so in the changelog. Beyond that, permission
persistence lives in the client, not in this server; connector-level and
per-tool settings are both worth checking, since granting at the connector
level does not always write through to every tool.

## Example requests

Use the official Strava MCP connector to discover activity ids, then pass them
to these tools.

**Activity writing**

- "Update the title of activity 12345678 to 'Morning Threshold'"
- "Add a note to my last ride: 'Felt strong on the climbs'"

**Analysis and visualization**

- "Show me the HR zone breakdown for activity 12345678"
- "Compare my two long runs from last week"
- "Show me the cadence trends for my last 10 runs"
- "View the route map for my last ride"

**Stats**

- "What are my running stats for this year on Strava?"

**Training analysis**

- "Break down the intervals in activity 12345678 — did I fade across the reps?"
- "How much did the climbs cost me on Sunday's long run?"
- "Did I positive-split Sunday's long run, or was that just the hills?"
- "Am I fresh enough to race this weekend? Check my CTL, ATL, and TSB"
- "My race is on 13 September — what should the next three weeks look like so I arrive at TSB +10?"
- "Did I decouple on that marathon-pace effort?"
