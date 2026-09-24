# Tool reference

Everything the server exposes: tools, prompts, permission behaviour, and
example requests. The single home for this catalog — README and AGENTS.md link
here instead of keeping copies.

Tool names and schemas are a published contract: grants are stored per tool
identity, so renames or schema reshapes re-prompt every user. See
[architecture.md](architecture.md#tool-metadata) before changing either.

> **Status.** Tools are being ported from Strava to intervals.icu (Phases 1
> and 2). Until a tool is ported, it fails with a "not yet ported" error.

## intervals.icu tools

Tools that already talk to intervals.icu directly, rather than through the
Strava port.

| Tool | Description |
| ---- | ----------- |
| `list-activities` | Compact, date-bounded activity list with units; the entry point for finding activity ids |
| `get-activity` | One activity in detail: metrics, load, HR zones, running dynamics, intervals; use after list-activities |
| `get-activity-streams` | Time-series streams for one activity, downsampled to a bounded number of points, including running dynamics |
| `list-gear` | The athlete's gear (shoes) with mileage and retirement status |
| `get-wellness` | Daily wellness (HRV, resting HR, sleep, weight, CTL/ATL/TSB) for a date or range |

`list-activities` defaults to the last 28 days (today back to 27 days
earlier) in the server's configured time zone, sorted newest first. Filter
with `type` (exact, case-insensitive) or `nameContains` (case-insensitive
substring), and cap the page with `limit` (1-200, default 30). An activity
synced into intervals.icu from Strava (`source: "STRAVA"`) is a stub: the
intervals.icu API has no further detail for it, so the response flags it with
`is_strava_stub` and the text response adds a trailing note.

`get-activity` takes the `id` from `list-activities` and returns core
metrics, training load, HR zone time-in-zone, running dynamics (runs with
device support), and the WORK/RECOVERY interval breakdown
(`includeIntervals`, default true), all with units. HR zone boundaries come
from the athlete's Run sport settings; when those aren't configured, or the
activity isn't a run, `hr_zones` is an empty array rather than failing the
call. `gap_min_per_km` (grade-adjusted pace) is derived from the activity's
`gap` field, which intervals.icu reports in m/s, the same unit as
`average_speed`.

`get-activity-streams` returns selected streams (`types`, default time,
distance, heartrate, cadence, velocity_smooth, altitude; also available:
latlng, watts, stance_time, vertical_oscillation, vertical_ratio,
step_length) as index-aligned arrays with units. Large activities are
downsampled to `maxPoints` (10-2000, default 200): each bucket reports the
mean of its non-null samples, except time, distance, and latlng, which take
the bucket's last sample. `time` is always fetched to size the buckets, but
only returned when requested. cadence is doubled to steps/min for run
activity types. A requested type the activity's streams don't include comes
back in `missing` rather than failing the call; an activity with no streams
at all fails with a clear message naming the id.

`list-gear` returns each gear item's distance (km, including any starting
distance entered in the UI when it was added, not just distance logged
through activities), activity count, retirement status, and any usage
reminders. Retired gear is excluded by default (`includeRetired`, default
false). An account with no gear returns `count: 0` and a message pointing to
the intervals.icu Gear page.

`get-wellness` returns daily wellness: HRV (both `hrv_sdnn_ms` and
`hrv_rmssd_ms`), resting HR, sleep, weight, training load (`ctl`, `atl`,
`tsb` = ctl minus atl), and the subjective/device fields (readiness,
soreness, fatigue, stress, mood, motivation, SpO2, respiration, comments).
Takes either a single `date` or an `oldest`/`newest` range (max 90 days);
supplying `date` together with a range is a validation error. With nothing
supplied it defaults to today in the server's configured time zone. Apple
Watch reports HRV as SDNN, not rMSSD: the response's `hrv_note` says so
explicitly, since `hrv_rmssd_ms` reads null for those athletes and should not
be compared against rMSSD norms.

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
30 read tools set `readOnlyHint: true` and `destructiveHint: false`, which is
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

These examples assume you already have an activity id to pass to a tool.

**Activity writing**

- "Update the title of activity 12345678 to 'Morning Threshold'"
- "Add a note to my last ride: 'Felt strong on the climbs'"

**Analysis and visualization**

- "Show me the HR zone breakdown for activity 12345678"
- "Compare my two long runs from last week"
- "Show me the cadence trends for my last 10 runs"
- "View the route map for my last ride"

**Stats**

- "What are my running stats for this year?"

**Training analysis**

- "Break down the intervals in activity 12345678 — did I fade across the reps?"
- "How much did the climbs cost me on Sunday's long run?"
- "Did I positive-split Sunday's long run, or was that just the hills?"
- "Am I fresh enough to race this weekend? Check my CTL, ATL, and TSB"
- "My race is on 13 September — what should the next three weeks look like so I arrive at TSB +10?"
- "Did I decouple on that marathon-pace effort?"
