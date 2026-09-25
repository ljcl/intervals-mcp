# Tool reference

Everything the server exposes: tools, prompts, permission behaviour, and
example requests. The single home for this catalog — README and AGENTS.md link
here instead of keeping copies.

Tool names and schemas are a published contract: grants are stored per tool
identity, so renames or schema reshapes re-prompt every user. See
[architecture.md](architecture.md#tool-metadata) before changing either.

> **Status.** Tools are being ported from Strava to intervals.icu (Phases 1
> and 2). The sixteen tools below are ported and verified against a real
> account. Still Strava-backed, and failing with a "not yet ported" error
> until a later phase: `get-training-load`, `get-fitness-trend`,
> `update-activity`, and the Phase 4 `view-*`/`get-*-data` app tools (see
> [Activity tools](#activity-tools) and [Visualization tools](#visualization-tools)).

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
| `get-activity-laps` | Laps of an activity, derived from its intervals, with sport-aware pace/speed, GAP, HR, power, cadence |
| `get-running-summary` | get-activity's detail fields for a run plus cadence, HR zone, and running-dynamics assessments, and a lap breakdown |
| `get-activity-zones` | Time spent in each HR and power zone for an activity, from the activity's own recorded zone bounds |
| `compare-activities` | Compare two activities side-by-side: pace, HR, cadence, load, and running dynamics, plus activity2-activity1 differences and an efficiency verdict |
| `get-hill-analysis` | Climb/descent detection with GAP and early-vs-late climb effort drift |
| `get-split-analysis` | Even km splits with a two-halves pacing verdict stated on the clock and grade-adjusted |
| `get-aerobic-analysis` | Aerobic decoupling and efficiency factor, preferring intervals.icu's own values and computing from streams otherwise |
| `get-interval-analysis` | Interval detection with urban-stop-aware rest classification and rep fade |
| `get-best-efforts` | Best times at standard running distances, from intervals.icu's pace curves |
| `get-race-prediction` | Predicted race times from intervals.icu pace-curve points (Riegel) alongside intervals.icu's own critical-speed model, with confidence, source point, and km goal-pace splits |
| `get-athlete-stats` | Run totals (this week, last 4 weeks, this month, YTD) aggregated from list-activities data |

`list-activities` defaults to the last 28 days (today back to 27 days
earlier) in the server's configured time zone, sorted newest first. Filter
with `type` (exact, case-insensitive) or `nameContains` (case-insensitive
substring), and cap the page with `limit` (1-200, default 30). An activity
synced into intervals.icu from Strava (`source: "STRAVA"`) is a stub: the
intervals.icu API has no further detail for it, so the response flags it with
`is_strava_stub` and the text response adds a trailing note. That detection
is unverified against a real Strava-sourced activity; see docs/api-notes.md's
Strava stub spike note.

`get-activity` takes the `id` from `list-activities` and returns core
metrics, training load, HR zone time-in-zone, running dynamics (Run,
TrailRun, VirtualRun, Walk, Hike, with device support), the WORK/RECOVERY
interval breakdown (`includeIntervals`, default true), gear id, and
description, all with units. Gear name is included too when the activity
payload happens to carry one; intervals.icu does not populate it there
today, so this is currently always id-only. HR zone boundaries come from
the activity's own recorded `icu_hr_zones` when present (any activity
type), the same source `get-activity-zones` reads; otherwise they fall back
to the athlete's Run sport settings group (`types` Run, VirtualRun,
TrailRun) when that group covers the activity's type. `hr_zones` is an
empty array when neither source is usable, rather than failing the call.
`pace_min_per_km` and `gap_min_per_km` (grade-adjusted pace, derived
from the activity's `gap` field, which intervals.icu reports in m/s, the
same unit as `average_speed`) are set for Run/TrailRun/VirtualRun only: a
Walk or Hike gets a cadence but no pace. The text response truncates
`description` to 200 characters with a "..." marker;
`structuredContent.description` is always the full text.

`get-activity-streams` returns selected streams (`types`, default time,
distance, heartrate, cadence, velocity_smooth, altitude; also available:
latlng, watts, stance_time, vertical_oscillation, vertical_ratio,
step_length) as index-aligned arrays with units. Large activities are
downsampled to `maxPoints` (10-2000, default 120): each bucket reports the
mean of its non-null samples, except time, distance, and latlng, which take
the bucket's last sample. `time` is always fetched to size the buckets, but
only returned when requested. cadence is doubled to steps/min (unit `spm`)
for Run/TrailRun/VirtualRun/Walk/Hike; other sport types keep the raw rate,
reported in `rpm`. A requested type the activity's streams don't include
comes back in `missing` rather than failing the call; an activity with no
streams at all fails with a clear message naming the id. The text response
repeats the returned columns as a CSV block (header row of `type_unit`
column names, one row per point; `latlng` as two columns, `lat` and `lng`)
after the summary lines, since some hosts pass only that text to the model
and drop `structuredContent`.

`list-gear` returns each gear item's distance (km, including any starting
distance entered in the UI when it was added, not just distance logged
through activities), activity count, retirement status, and any usage
reminders. Retired gear is excluded by default (`includeRetired`, default
false). An account with no gear returns `count: 0` and a message pointing to
the intervals.icu Gear page.

`get-wellness` returns daily wellness: HRV (both `hrv_sdnn_ms` and
`hrv_rmssd_ms`), resting HR, sleep, weight, training load (`ctl`, `atl`,
`tsb` = ctl minus atl), and the subjective/device fields (readiness,
soreness, fatigue, stress, mood, motivation, `spo2` (%), `respiration`
(breaths/min), comments); `units` names all of these, including `spo2` and
`respiration`. Takes either a single `date` or an `oldest`/`newest` range
(max 90 calendar days inclusive); supplying `date` together with a range is
a validation error. With nothing supplied it defaults to today in the
server's configured time zone. Apple Watch reports HRV as SDNN, not rMSSD:
the response's `hrv_note` says so explicitly (and every text line labels it
"HRV SDNN", never bare "HRV"), since `hrv_rmssd_ms` reads null for those
athletes and should not be compared against rMSSD norms.

`get-activity-laps` takes the `id` from `list-activities` and returns laps
derived from the activity's intervals (`icu_intervals`, fetched via
`getActivity(..., { intervals: true })`): intervals.icu has no separate lap
list, and `icu_intervals` usually mirrors the device's own laps (typically
one WORK interval per lap, sometimes with a short RECOVERY inserted between
them), for any sport. Runs report `pace_min_per_km` and grade-adjusted
`gap_min_per_km` (`gap_source: "intervals.icu"`, from the lap's own `gap`
field, not the locally-modelled GAP hill/split analysis compute); other
distance sports report `speed_kmh`. Cadence is spm
(doubled from strides) for Run/TrailRun/VirtualRun/Walk/Hike, rpm otherwise,
with the unit named in `units.cadence`. The response also carries
`device_lap_count` (`icu_lap_count`) and `intervals_edited`
(`icu_intervals_edited`); the text flags it when intervals were edited or
the interval count differs from the device's lap count. An activity with no
intervals returns a valid payload with `lap_count: 0`.

`get-running-summary` takes the `id` from `list-activities` and is a thin
wrapper over `get-activity`'s mapper: every field `get-activity` returns,
plus a `cadence_assessment` (from `average_cadence_spm`), an `hr_zone_summary`
(time and percent per zone), a `dynamics_assessment` (vertical oscillation
and ground contact time against the 100 mm / 200-260 ms targets, only when
`running_dynamics` is present), and `laps` (from the same interval mapper as
`get-activity-laps`). No power fields. `hr_zone_summary` prefers the
activity's own recorded `icu_hr_zones` as zone bounds, falling back to the
Run sport settings group only when its `types` names this activity's type;
it is `null` (with `hr_zone_note` explaining why) when no bounds match the
recorded zone time count. Only Run, TrailRun, and VirtualRun are accepted;
any other type is rejected with a message naming the type and pointing to
`get-activity`. The text response caps the lap list at 20 lines;
`structuredContent.laps` always has the full list.

`get-activity-zones` and the `view-activity-zones`/`get-activity-zones-data`
MCP App share one mapper (`mapIntervalsZones`): heart rate from the
activity's own `icu_hr_zones` (upper bounds, zone 1's lower bound is always
0) and `icu_hr_zone_times`, power from `icu_power_zones` and `icu_zone_times`
only when both are present. Unlike get-activity's `hr_zones`, there is no
sport-settings fallback here; pace zones are out of scope (Phase 4). Heart
rate is omitted, with a warning in the text, when the activity recorded
bounds and zone times with different zone counts. An activity with no zone
data returns a valid empty payload, not an error.

`compare-activities` and the `view-compare-activities`/`get-compare-activities-data`
MCP App's summary half share one `buildComparison(a, b)`, so text and app
output can never drift. Each side reports the same fields `get-activity`
does for one activity: `pace_min_per_km`/`gap_min_per_km` as `m:ss` strings
(`gap_source: "intervals.icu"`), training load (`icu_training_load`),
decoupling, efficiency factor, and running-dynamics averages when the
device recorded them. Differences are derived from each activity's raw
distance/time/HR/cadence, never from the rounded or formatted per-side
fields; the pace delta renders as `pace_delta_min_per_km` (signed `m:ss`)
plus `pace_delta_sec_per_km` (the underlying signed seconds) and
`pace_delta_interpretation`. A non-running activity on either
side degrades to a warning rather than failing the call. The app's stream
overlay (`get-activity-streams-raw`) is still Strava-backed, pending Phase 4.

`get-hill-analysis` and `get-split-analysis` both read their streams through
the shared intervals.icu stream adapter (`distance`, `altitude`,
`grade_smooth`, `heartrate`, `velocity_smooth`, `cadence`, plus a derived
`moving` flag) and share one grade/GAP implementation
(`gapFactor`/`computeGrades` in `hillAnalysis.ts`): grade prefers
intervals.icu's `grade_smooth` stream, falling back to an altitude-window
derivation when it is absent or entirely null, and `grade_source` in the
response names which was used. A null sample in `distance`/`altitude`/grade
is interpolated between its known neighbours (held flat across a leading or
trailing gap) rather than treated as zero; a null HR/cadence/velocity sample
is simply excluded from whatever average it would have fed. Pace is a bare
`m:ss` string in `pace_min_per_km`/`gap_pace_min_per_km`, the `/km` suffix
added only in the text output; splits are kilometres only. GAP here is
locally modelled from grade (`gap_source: "model"`), distinct from
get-activity/compare-activities/get-activity-laps/get-running-summary's
`gap_source: "intervals.icu"` (their own recorded `gap` field). An activity
with no recorded
streams at all (e.g. Pilates, or a manual entry) fails with a message naming
the activity rather than an empty analysis.

`get-hill-analysis` detects sustained climbs and descents (grade ≥ 2% for
≥ 200 m, tolerant of brief dips) and reports per segment: length, average
grade, elevation change, moving and grade-adjusted pace, HR, cadence, and
power. The headline is early-vs-late climb drift: HR per unit of
grade-adjusted speed compared between climbs in the first and second half of
the activity, or GAP pace alone without HR, positive meaning the same
climbing cost more late in the run.

`get-split-analysis` bins the streams into fixed 1 km splits (device laps
are ignored) and states a two-halves verdict twice: once on the clock, once
grade-adjusted, cut at the exact midpoint of recorded distance rather than
by grouping splits. `terrain_pct` names how many percentage points of the
raw change the terrain accounts for, so a hilly back half is not misread as
fade and a course that flattens out does not hide real fade.

`get-aerobic-analysis` prefers the activity's own `decoupling` and
`icu_efficiency_factor` fields when intervals.icu has already computed them
(`decoupling_source`/`efficiency_factor_source: "intervals.icu"`), and in
that case skips the stream fetch entirely unless `includeBreakdown: true` is
passed. Otherwise both are computed from streams
(`source: "computed"`) using the shared intervals.icu stream adapter. The
`basis` input picks the output stream: `pace` (default) reads
`velocity_smooth`, `power` reads `watts`; pace figures render as a bare
`m:ss` string in `avg_pace_min_per_km`/`normalized_pace_min_per_km`, never
miles. On the power basis a recording device name starting
with `Watch` (an Apple Watch) adds a warning that the power stream is
Apple's own estimate, not a power meter reading. Warm-up exclusion defaults
to the activity's `icu_warmup_time`, then the athlete's Run sport-settings
`warmup_time`, then 5 minutes; intensity factor's threshold power defaults to
the athlete's Run sport-settings `ftp`, then the activity's `icu_ftp`.

`get-interval-analysis` classifies every stopped segment (from the derived
`moving` stream) before trusting it as interval structure: under 60 s with no
fast effort before it is a traffic light (excluded), up to 3 min after a fast
effort is genuine recovery, over 5 min is a café/regroup stop (excluded),
anything else is unclassified and lowers confidence. When the activity
carries clean structured intervals.icu laps (`icu_intervals`, WORK/RECOVERY)
those are preferred over stream reconstruction; they also catch
jog-recovery sessions, which never stop moving, and fall back to streams
when the laps' speeds are not tightly clustered (rain, sweat, a
non-effort-based auto-lap split). Work reps are reconstructed between
recoveries, merging straight through traffic lights, and reported with
per-rep pace (`pace_min_per_km`, bare `m:ss`), HR, cadence, and power; fade compares the last rep
against the first. An HR-distribution tiebreaker ("was this a workout at
all") reports the share of moving time at ≥ 88% of the activity's own max HR.

`get-best-efforts` reports best times at standard distances (400m, 1km, 5km,
10km, half marathon, marathon by default, or a subset via `distances`) from
intervals.icu's pace curves rather than scanning activities. `window` picks
`all`, `1y` (default), `90d`, or a custom `YYYY-MM-DD..YYYY-MM-DD` range,
mapped to the matching pace-curve id. `topN` (1-5, default 1) picks how many
distinct activities to report per distance: the default makes one call to the
athlete's own pace curve, whose `activities` map already carries the name,
date, and race flag; above 1 fetches per-activity pace curves for the window
to rank the top N distinct activities per distance locally (intervals.icu
returns no rank), then resolves the name and race flag for each winning
activity with one bounded-concurrency `getActivity` call per unique id (at
most 30, distances x topN), never a `list-activities` sweep over the whole
window. Pace renders as a bare `m:ss` string in `pace_min_per_km`, never
miles. Because
the pace curve is built from the recorded time stream (a moving-time style
curve), `time_seconds`/`time_formatted` are not elapsed time; the response's
`note` says so. Each requested distance is matched to the nearest point on
intervals.icu's curve, but only within tolerance (2% of the target or 50m,
whichever is larger): a distance with no point that close, whether the
window's curve is empty or its nearest point is simply too far away (a short
window's only 5K is never reported as its marathon time), comes back as an
empty list, named in `missing`, with a matching warning, rather than failing
the whole call or mislabelling an unrelated distance.

`get-race-prediction` predicts race times from intervals.icu's `all` and `90d`
pace curves rather than scanning activities: each curve's distance-grid points
become prediction inputs (the `all` curve giving the fastest ever at a
distance, `90d` the fastest of the last 90 days), combined with Riegel's
equivalent-performance formula and weighted by recency and extrapolation
distance, the same consensus/confidence math as before. Alongside each Riegel
estimate it reports intervals.icu's own critical-speed model fit to the same
pace curve (`time = (distance - dPrime) / criticalSpeed`), stated as valid for
roughly 3 to 60 minute efforts; a prediction outside that window, a marathon
for instance, is still returned and flagged rather than hidden. `raceDistance`
(optional) adds a km split table (even and negative-split) for that race, and
`goalTime` paces it to a goal instead of the prediction. Output is km only, no
mile paces or splits. Pace is a flat `pace_sec_per_km`/`pace_min_per_km` pair
(bare `m:ss`), matching every other tool, wherever a prediction, the goal
target, or a split row reports one; `units.distance` is `"m"`, matching the
`distance_m` fields the response actually carries.

## Activity tools

Still Strava-backed; not yet ported to intervals.icu (Phase 3+).

| Tool | Description |
| ---- | ----------- |
| `update-activity` | Update an activity's description, title, sport type, gear, or flags |
| `get-training-load` | Training load summary with trend analysis |
| `get-fitness-trend` | Fitness/fatigue/form (CTL/ATL/TSB) from relative effort, with rest projection and a solved taper to a target form on a target date |

## Visualization tools

Each `view-*` MCP App has an app-only `get-*-data` companion that fetches what
the UI renders. `view-compare-activities`/`get-compare-activities-data` and
`view-activity-zones`/`get-activity-zones-data` are ported to intervals.icu;
the rest are still Strava-backed, pending Phase 4.

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
| `view-activity-zones` | Time-in-zone bar chart for one activity's HR zones with an easy/moderate/hard split (power zones dropped for now; see docs/api-notes.md) (MCP App) |
| `get-activity-zones-data` | Per-zone time distributions (bucket bounds, seconds, percentages) for the activity-zones UI (app-only) |
| `view-fitness-trend` | CTL/ATL/TSB over time with shaded fatigue/freshness/ramp bands and a dashed taper plan or rest projection past today (MCP App) |
| `get-fitness-trend-data` | Per-day CTL/ATL/TSB, the projection, the solved taper, and the dated warning bands for the fitness-trend UI (app-only) |

## Prompts

Reusable multi-step workflows a host can offer as slash commands or starters.

| Prompt | Arguments | What it does |
| ------ | --------- | ------------ |
| `weekly-review` | `weeks` (optional, default 4) | Reviews recent training (load trend, key workouts, cadence patterns), ending with focus points for next week |
| `annotate-last-run` | `activity_id` (optional, defaults to the most recent run) | Analyses a run and appends a short coaching note to its activity description. Confirms before writing |

In Claude Desktop and Claude Code these appear in the prompt picker once the
server is connected. `annotate-last-run` uses a write tool (`update-activity`),
so it needs the `activity:write` scope.

## Tool permissions

Every tool declares MCP annotations so a host can tell reads from writes. The
32 read tools set `readOnlyHint: true` and `destructiveHint: false`, which is
the combination clients use to offer a durable "always allow". One tool is a
write and is expected to keep asking:

| Tool | Why it asks |
| ---- | ----------- |
| `update-activity` | Overwrites an existing activity's fields |

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
