# Intervals MCP Server: capability reference

Upload this file as project knowledge in a Claude project connected to the
intervals-mcp server. It orients the model and the athlete on what the server
can do, how to read its output, and where the sharp edges are. Full
per-tool schemas and parameters live in [docs/tools.md](tools.md); this file
is a map of that catalog by purpose, not a replacement for it.

The server also sends a short version of this guide to every chat as its MCP
instructions: the routing, the id format, units and time zone, and the
`update-activity` rules. So a chat starts oriented without this file. This
file stays the long form, for the full detail on each area.

## Overview

intervals-mcp connects Claude to an athlete's intervals.icu account: activity
history, wellness, fitness/fatigue trend, and detailed run analysis (hills,
splits, intervals, aerobic decoupling, race prediction), plus one write tool
to update an activity's name, description, gear, RPE, or feel. Read tools
report numbers with explicit units and flag missing or ambiguous data rather
than guessing; the write tool never claims a change happened when it isn't
sure. Several tools have a matching interactive chart view (an MCP App) for
the same data.

## Tools by purpose

"Opens a view" means the tool renders an interactive chart in the client
rather than (or alongside) text.

### Discovery

| Tool | Answers | Key params |
| ---- | ------- | ---------- |
| `list-activities` | What did I do recently? What's this activity's id? | `oldest`/`newest` (YYYY-MM-DD, default last 28 days), `type`, `nameContains`, `limit` |
| `get-activity` | Full detail on one activity | `id` |
| `list-gear` | What shoes/bikes do I have, and their mileage? | `includeRetired` |
| `get-wellness` | HRV, resting HR, sleep, weight, CTL/ATL/TSB for a day or range | `date`, or `oldest`/`newest` (max 90 days) |

### Per-activity detail

| Tool | Answers | Key params |
| ---- | ------- | ---------- |
| `get-activity-laps` | What were the lap splits? | `id` |
| `get-running-summary` | One-shot run readout: metrics, HR zones, cadence, dynamics, laps | `id` |
| `get-running-dynamics` | Ground contact time, vertical oscillation/ratio, step length | `id`, `includeIntervals` |
| `get-activity-zones` | Time in each HR zone (power zones are not reported yet) | `id` |
| `get-activity-streams` | Raw time-series (HR, pace, cadence, power, altitude...) | `id`, `types`, `maxPoints` |

### Per-activity analysis

| Tool | Answers | Key params |
| ---- | ------- | ---------- |
| `get-hill-analysis` | How did the climbs go, and did I fade on them late? | `id` |
| `get-split-analysis` | Did I positive-split, or was that the hills? | `id` |
| `get-aerobic-analysis` | Did I decouple? What's my efficiency factor? | `id`, `basis` (pace or power) |
| `get-interval-analysis` | Interval workout breakdown: pace/HR per rep, did reps fade? | `id` |
| `compare-activities` | How does this run compare to that one? | `activityId1`, `activityId2` |

### Fitness, load, and performance

| Tool | Answers | Key params |
| ---- | ------- | ---------- |
| `get-athlete-stats` | Run totals this week/month/YTD | (none) |
| `get-fitness-trend` | Am I fresh or fatigued? What if I taper for a race? | `days`, `runOnly`, `projectDays`/`plannedLoads`, `targetDate`/`targetTsb` |
| `get-training-load` | Weekly volume, injury-risk flags, weekly load | `days`, `runOnly` |
| `get-best-efforts` | My best 5K/10K/half/marathon times | `distances`, `window`, `topN` |
| `get-race-prediction` | What could I run for X? What pace do I need for a goal time? | `raceDistance`, `goalTime` |

### Writes

| Tool | Answers | Key params |
| ---- | ------- | ---------- |
| `update-activity` | Change an activity's name, description, gear, RPE, or feel | `id`, `name`, `description`, `descriptionMode`, `gearId`, `rpe`, `feel` |

### Visualization (opens a view)

Each view tool has a data companion that the chart itself calls. The data
tools are app-only: they are hidden from the model's tool list, so for the
same numbers as text use the matching read tool (e.g. `get-fitness-trend`,
`get-training-load`).

| View tool | Data tool | Shows |
| --------- | --------- | ----- |
| `view-activity-chart` | `get-activity-streams-raw` | HR, power, pace, altitude, cadence, grade, and dynamics overlays with interval bands |
| `view-cadence-trends` | `get-cadence-trend-data` | Cadence over time: timeline, scatter, zones, overlay views |
| `view-route-map` | `get-route-map-data` | GPS track with start/finish markers and optional waypoints |
| `view-training-load` | `get-training-load-data` | Weekly volume bars with a trend line and injury-risk weeks |
| `view-compare-activities` | `get-compare-activities-data` | Two activities' streams overlaid with a delta summary |
| `view-activity-zones` | `get-activity-zones-data` | Time-in-zone bar chart for HR |
| `view-fitness-trend` | `get-fitness-trend-data` | CTL/ATL/TSB over time with fatigue/freshness bands and a taper plan; toggles whole-body vs runs-only |

## Typical workflows

**Weekly review.** `get-training-load` for volume/trend/warnings, then
`list-activities` to spot standout sessions, `get-running-summary` (and
`compare-activities` for two comparable runs) on those, then
`view-cadence-trends` to explore cadence patterns. (This is also the
`weekly-review` prompt.)

**Single-run analysis.** `get-running-summary` first for the overall picture,
then drill into `get-activity-laps`, `get-hill-analysis`, `get-split-analysis`,
`get-aerobic-analysis`, or `get-interval-analysis` depending on what the run
was (hilly course, workout, long steady run).

**Race prediction.** `get-race-prediction` alone. Pass `raceDistance` for a
km split table, or `goalTime` to pace splits to a target instead of a
prediction. It uses one pace-curve point per run and counts runs marked as
races in intervals.icu double, so a history of training runs alone usually
predicts on the slow side.

**Fitness and taper planning.** `get-fitness-trend` with `targetDate` and
`targetTsb` to solve a taper (or `projectDays`/`plannedLoads` to project
forward under an assumed plan), or `view-fitness-trend` for the same thing as
a chart with a Whole body / Runs only toggle.

**Updating an activity.** `get-running-summary` and `get-activity-laps` for
context, draft a short note, show it to the athlete and get confirmation,
then `update-activity` with `descriptionMode: "append"` so the existing
description is kept. (This is also the `annotate-last-run` prompt.)

## Gotchas

- **Activity id format.** Ids are digit strings, optionally prefixed with
  `i` (as `list-activities` returns them, e.g. `i189807578`). Always pass ids
  as quoted strings, never bare numbers: some hosts round large numbers
  through JSON, which silently corrupts the id.
- **Whole-body vs runs-only fitness.** `get-fitness-trend` and
  `get-training-load` default to whole-body CTL/ATL/TSB, read straight from
  intervals.icu's own wellness record and covering every activity type.
  `runOnly: true` switches to a separate, locally-computed series covering
  only Run/TrailRun/VirtualRun. The two scopes can report materially
  different numbers for the same athlete and answer different questions;
  don't mix them in one comparison without saying which scope each number is.
- **Gaps in charts are missing data, not zero.** Streams with no recorded
  sample (a dropped HR strap, a watch that doesn't record running dynamics
  continuously) show as a break in the line, not a dip to zero. This applies
  mid-activity too, not just at the start or end, and shows up most on
  running-dynamics overlays (ground contact time, vertical oscillation).
- **Gear cannot be cleared, only changed.** `update-activity` can switch an
  activity's gear to a different item, but setting it to "none" does
  nothing: intervals.icu silently ignores a null gear id.
- **A description needs a mode when one already exists.** If the activity
  already has a description, and the new text does not already contain it,
  an `update-activity` call with no `descriptionMode` writes nothing. The
  error shows the existing text's length and first 120 characters. Resend
  with `append` to keep it and add below, or `replace` to overwrite it.
  After a `replace` that drops text, the reply quotes what was removed.
- **`update-activity` write semantics.** It reads the activity fresh, sends
  only the fields that actually changed, and reports exactly what changed
  with before/after values. If the write times out or something fails
  afterward (the confirming re-read, for instance), it does not know whether
  the change landed and says so explicitly rather than guessing. If you see
  that message, check with `get-activity` before retrying, rather than
  sending the same update again.
- **Walks, hikes, and other non-running sports.** Pace fields
  (`pace_min_per_km`, `gap_min_per_km`) are only populated for Run/TrailRun/
  VirtualRun; a Walk or Hike gets cadence but no pace. Cadence itself is
  doubled to steps/min for Run/TrailRun/VirtualRun/Walk/Hike; other sports
  report the raw rate in rpm. HR zone tools generally need the activity's own
  recorded zone bounds or a matching Run sport-settings group; without
  either, HR zone data comes back empty rather than wrong.
- **Strava-stub activities.** An activity synced into intervals.icu from
  Strava with no further detail is flagged (`is_strava_stub`); don't expect
  streams or laps for it.

## Units

- **Pace** is always a bare `m:ss` string per kilometre, in a
  `*_min_per_km` field (`pace_min_per_km`, `gap_min_per_km`,
  `avg_pace_min_per_km`), never miles. Where a tool also needs the number
  for arithmetic it adds a paired `*_sec_per_km` field in seconds
  (`get-race-prediction`'s `pace_sec_per_km`, `compare-activities`'
  `pace_delta_sec_per_km`).
- **`units` object.** Most tool responses include a `units` object naming
  every field's unit explicitly (distance, HR, cadence spm vs rpm, HRV in
  ms, SpO2 in %, respiration in breaths/min), so a unit is never implied.
- **Distance** is metres or kilometres, named per field; `get-race-prediction`
  reports distance in metres (`units.distance: "m"`, `distance_m` fields).
- **HR** is beats per minute. **Load** is intervals.icu's own training-load
  units (`icu_training_load`), summed or averaged per day or week depending
  on the tool.

## Rate limits and caching

The server paces its own calls to intervals.icu (about one request every
200ms) rather than reacting to rate-limit responses, since intervals.icu
doesn't send rate-limit headers. A request that pulls several pieces of data
may take a moment longer than a single-field lookup; this is normal pacing,
not an error.

Reads are cached briefly to avoid re-fetching the same data:

- Activity detail, streams, and intervals, plus gear: 10 minutes
- Sport settings: 1 hour
- Activity list: 1 minute
- Wellness: 5 minutes
- Pace curves: 10 minutes

After `update-activity` writes, the affected activity's cache entry (and
related list/gear entries) is cleared immediately, so a follow-up
`get-activity` reflects the change right away. Anything not written stays on
its normal cache schedule, so a very recent edit made outside this
conversation (directly on intervals.icu) may take up to the TTL above to
show up here.
