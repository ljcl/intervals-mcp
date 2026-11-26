---
name: run-analysis
description: Use to analyse one activity or to compare two. Covers the run summary, laps, splits, hills, intervals, aerobic decoupling, running dynamics, time in zones, raw streams and weather, which tool to call first and which analysis fits which session, and how to read moving time, zone bounds, other sports and similar sessions.
---

# Analysing a run

## Start with the summary

Call `get-running-summary` first for the overall picture. Then call the one
analysis that fits what the run was:

| The run was | Call |
| ----------- | ---- |
| A workout with structured reps | `get-interval-analysis`, with `findSimilar: true` to compare with earlier sessions of the same reps |
| A steady run on a mostly flat course | `get-split-analysis` |
| Hilly for its distance | `get-hill-analysis` |
| A long, easy, steady run | `get-aerobic-analysis`, for decoupling |

For other sports, use `get-activity`. The `run-debrief` prompt runs this
sequence, and adds that day's wellness from `get-wellness`.

## Per-activity detail

| Tool | Answers | Key inputs |
| ---- | ------- | ---------- |
| `get-running-summary` | One readout for a run: metrics, HR zones, cadence, dynamics, laps, weather (with humidity and dew point when the FIT file has them), and decoupling and efficiency factor (computed from the streams when intervals.icu has none) | `id` |
| `get-activity-laps` | What were the lap splits? | `id`, `fromLap` |
| `get-running-dynamics` | Ground contact time, vertical oscillation and ratio, step length | `id`, `includeIntervals`, `fromLap` |
| `get-activity-zones` | Time in each HR zone and, for a run, each pace zone (GAP when the activity uses it). Power zones are not reported yet | `id` |
| `get-activity-streams` | Raw time series (HR, pace, cadence, power, altitude, corrected altitude and more) | `id`, `types`, `maxPoints` |

## Per-activity analysis

| Tool | Answers | Key inputs |
| ---- | ------- | ---------- |
| `get-hill-analysis` | How did the climbs go, and did I fade on them late? | `id`, `elevationSource` (`corrected` by default, `barometric`, or `both` for each source's climbs side by side) |
| `get-split-analysis` | Did I positive-split, or was that the hills? | `id`, `elevationSource` |
| `get-aerobic-analysis` | Did I decouple? What is my efficiency factor? | `id`, `basis` (`gap`, `pace` or `power`; `gap` corrects for hills), `elevationSource` (`both` shows decoupling on each elevation source and warns when they disagree) |
| `get-interval-analysis` | Pace and HR per rep, and did the reps fade? Am I faster than the last times I did this workout? | `id`, `findSimilar` |
| `compare-activities` | How does this run compare with that one? Was the gap there from km 1 (conditions) or did it grow (fatigue)? Was the weather different? Am I getting faster on my usual loop? | `activityId1` and `activityId2`, or `activityId1` with `sameRoute: true` |

## Rules for reading the numbers

### Three moving times, each labelled

intervals.icu's moving time for the activity (`get-activity`,
`get-running-summary`, `compare-activities`), the streams' moving time with
stops left out (`get-split-analysis` and the other stream tools; it matches
the watch's own timer), and intervals.icu's moving time per lap can differ by
tens of seconds on one run. So the paces differ by a few seconds per km.
Each pace's `moving_time_source` says which one it is (`intervals.icu`,
`streams` or `lap`). Quote the one that fits the question, and say which.

### Two sources of zone bounds

`get-athlete-zones` gives today's sport settings. `get-activity-zones` and
`get-running-summary` use the bounds recorded with each activity, which can
be older. HR zone tools need the activity's own recorded zone bounds or a
matching Run sport-settings group. Without either, the HR zone data is empty
rather than wrong.

### Other sports

- Pace fields (`pace_min_per_km`, `gap_min_per_km`) are filled only for
  Run, TrailRun and VirtualRun. A Walk or Hike gets cadence and `speed_kmh`
  but no pace, and the charts show it in km/h too.
- A swim gets `pace_min_per_100m` and no running dynamics. `get-activity`
  adds SWOLF and distance per stroke for a swim. Other sports with a
  distance get `speed_kmh`.
- Cadence is doubled to steps/min for Run, TrailRun, VirtualRun, Walk and
  Hike. A swim gives its stroke rate in strokes/min, and other sports give
  the raw rate in rpm (`units.cadence_label`).

### Weather

Humidity and dew point come from the FIT file (HealthFit writes Apple's
workout weather there). intervals.icu's own weather is empty unless the
athlete's settings fetch it. A temperature from the file can be a watch
sensor's reading, which a wrist warms. When the dew points in
`compare-activities` differ by more than 5 °C, it says so: part of the
heart rate difference can be the weather.

### Similar sessions are found from laps

`get-interval-analysis` with `findSimilar: true` compares only earlier
sessions whose laps show clean reps. A workout with no lap per rep (1 km
auto-laps only) is skipped and counted in `skipped`, not found. An empty
`sessions` list always comes with a `reason`. Quote it, rather than saying
the athlete never did the workout.

### Strava stubs

An activity synced into intervals.icu from Strava with no further detail is
flagged (`is_strava_stub`). Do not expect streams or laps for it.
