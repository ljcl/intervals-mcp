---
name: reading-intervals-data
description: Use for the basics behind any answer from this intervals.icu server. Covers finding an activity id, the input names, which unit a number is in, which view tool opens a chart and how to change a chart that is open, why a chart has gaps, and why a change made on intervals.icu does not show here yet.
---

# Reading intervals.icu data

This server connects you to one athlete's intervals.icu account:

- activity history, wellness, and the fitness and fatigue trend
- detailed run analysis: hills, splits, intervals, aerobic decoupling and
  race prediction
- route planning from the athlete's own runs
- three write tools: change an activity's name, description, gear, RPE or
  feel; log how the athlete feels on a day; and retire gear or set its
  mileage reminders

Read tools give numbers with explicit units, and they flag missing or
unclear data rather than guess. The write tools never claim that a change
happened when they are not sure. Several tools have a matching interactive
chart (an MCP App) for the same data.

## Finding things

| Tool | Answers | Key inputs |
| ---- | ------- | ---------- |
| `list-activities` | What did I do recently? What is this activity's id? When did I last do X? Each entry has `tags`, `race` and `achievement_types` (a best or a threshold rise) | `oldest`/`newest` (YYYY-MM-DD, default the last 28 days), `type` (`runs` for Run/TrailRun/VirtualRun, one type, or a comma list), `nameContains`, `search` (all history: a name substring or `#tag`), `limit` |
| `get-activity` | Full detail on one activity: gear name, swim pace per 100 m, HR recovery, and any best or threshold rise intervals.icu marked (an LTHR_UP is its estimate, not a changed setting; for a run PB, use `get-best-efforts`) | `id` |
| `list-gear` | What shoes or bikes do I have, their mileage, reminders and auto-assign rules? | `includeRetired` |
| `get-wellness` | HRV, resting HR, sleep, weight, CTL/ATL/TSB and how I felt, for a day or a range | `date`, or `oldest`/`newest` (up to 366 days; past 90 days it gives weekly averages without CTL/ATL/TSB, ramp, sleep score, SpO2, respiration or comments) |

## Activity ids

- Ids are digit strings, optionally with an `i` prefix, as
  `list-activities` gives them (`i189807578`).
- For the most recent run, pass id `"latest"` to a per-activity tool.
  `update-activity` does not take `"latest"`.
- Always pass an id as a quoted string, never as a bare number. Some hosts
  round large numbers through JSON, and that silently changes the id.
- A chart or map opened with `"latest"` stays on that run when the chat is
  opened again. The resolved id is in the result's `_meta`, which the host
  can read but usually does not pass on. When you need the id itself, call
  `list-activities`.

## Input names

The inputs use one camelCase scheme:

- `id` for one activity, `activityId1` and `activityId2` for two.
- `days` for a look-back window (`view-cadence-trends`: 7 to 728, default
  42).
- `newest` to end a look-back on a past date (`get-training-load`,
  `get-fitness-trend` and their charts).

Older spellings (`activity_id`, `weeks`) still work.

## Charts

A view tool opens an interactive chart in the client. Each view tool has a
data tool that the chart itself calls. The data tools are for the charts
only and are not in your tool list: for the same numbers as text, use the
matching read tool (for example `get-fitness-trend` or `get-training-load`).

| View tool | Data tool | Shows |
| --------- | --------- | ----- |
| `view-activity-chart` | `get-activity-streams-raw` | HR, power, pace, altitude, cadence, grade and dynamics overlays, with interval bands |
| `view-cadence-trends` | `get-cadence-trend-data` | Cadence over time: timeline, scatter, zones and overlay views |
| `view-route-map` | `get-route-map-data` | A GPS track with start and finish markers and optional waypoints. With `id`, `from_km` and `to_km`, only that part of a run, to check it before you save a corridor. With `route_id`, a stored route with a colour per section, km markers, via points, `compare_to_version`, and edits on the map (each one an `amend-route` call). A client without MCP Apps gets a picture |
| `view-route-suggestions` | `get-route-suggestions-data` | Past and new routes for a planned run, with a picker, an elevation strip and any hill for repeats |
| `view-training-load` | `get-training-load-data` | Weekly volume bars with a trend line and volume-spike weeks, a weekly load line, and Fitness/Fatigue/Form tiles. `runOnly` picks the starting scope, and the chart toggles between whole body and runs only. `newest` shows a past block |
| `view-compare-activities` | `get-compare-activities-data` | Two activities' streams overlaid, with a delta summary |
| `view-activity-zones` | `get-activity-zones-data` | Time in zone as bars, for HR and, for a run, pace zones |
| `view-fitness-trend` | `get-fitness-trend-data` | CTL/ATL/TSB over time with fatigue and freshness bands, and a taper plan or a calendar plan projection (`calendarPlan`). It toggles between whole body and runs only. `newest` shows a past block, with no projection |
| `view-wellness` | `get-wellness-trend-data` | HRV, resting HR and sleep on one date axis, with gaps where nothing was recorded. `oldest`/`newest` (default the last 30 days); weekly averages past 90 days |

When a chart is open, change it with that chart's own tool. Each reply says
what the card now shows.

- `set-brush-window`: the activity chart zooms to a stretch.
- `set-viewport`: the route map frames a stretch by km.
- `set-view`: cadence trends picks the view, the runs to overlay (by
  `list-activities` id) and the axis.
- `set-metric`: compare activities picks the metric and the axis.
- `set-scope`: fitness trend and training load pick whole body or runs only,
  and which series show.
- `set-zone-type`: activity zones picks heart rate or pace.

Every view tool's text carries the chart's numbers, so you do not need
another call for them. The text is the matching text tool's own text (for
example `get-fitness-trend` for `view-fitness-trend`), from the same call.

- The route map gives its distance, elevation and waypoints, then the climbs
  from `get-hill-analysis`.
- Cadence trends give each run's cadence, cadence by pace zone (the
  athlete's own Run pace zones from `get-athlete-zones`) and the
  cadence-against-pace slope. Runs under 1 km are left out and counted.

The first line of the text says the chart is shown only when the client said
it renders MCP Apps. Otherwise it says the chart may not show, because some
hosts show the card anyway.

## Gaps in charts are missing data, not zero

A stream with no recorded sample (a dropped HR strap, a watch that does not
record running dynamics all the time) shows as a break in the line, not a
drop to zero. This also happens in the middle of an activity, not only at
the start or end. You see it most on the running-dynamics overlays (ground
contact time, vertical oscillation).

## More detail

- [Units](references/units.md): pace, distance, heart rate, load and the
  `units` object.
- [Pacing and caching](references/caching.md): why a large request takes
  longer, and how long a change made on intervals.icu takes to show here.
