# Tool reference

Everything the server exposes: tools, prompts, permission behaviour, and
example requests. The single home for this catalog — README and AGENTS.md link
here instead of keeping copies.

Tool names and schemas are a published contract: grants are stored per tool
identity, so renames or schema reshapes re-prompt every user. See
[architecture.md](architecture.md#tool-metadata) before changing either.

> **Status.** All twenty tools below talk to intervals.icu directly and are
> verified against a real account. `get-fitness-trend`, `get-training-load`,
> and `get-running-dynamics` are exercised by `scripts/live-check.ts`;
> `update-activity`'s write path was verified once, separately, with
> explicit user approval, see docs/api-notes.md. Every MCP App tool below
> (see [Visualization tools](#visualization-tools)) reads intervals.icu
> streams and activity data through the same adapter; the retired Strava
> client has been deleted from the codebase (see AGENTS.md).

## Writing tool descriptions

A tool's `description` is what a model reads to choose the tool, so every
description has the same three parts:

1. What the tool does and when to use it, with an example request where it
   helps ("how was my run?").
2. When not to use it, and which tool to use instead. Tools that overlap
   name each other: `get-running-summary` says it already includes the laps
   and HR zone time, so `get-activity-laps` and `get-activity-zones` are
   skipped.
3. Only behaviour the schema does not show: defaults that depend on other
   data, errors, gaps, caveats.

Never add a "Parameters:" section. Each field's `.describe()` text already
reaches the host in the input schema, and those texts are part of
`tool-surface.lock.json`, so they cannot be reworded casually. Leave out
developer notes, repo paths and dated examples. Keep a description under
1,800 characters (about 1,200 is typical): Claude Code cuts it at 2,048, and
the model never sees the rest (#39). `server.integration.test.ts` checks the
cap over `tools/list`, rejects a "Parameters:" section, and checks that every
tool a description names exists. `buildToolDefs` trims the text, so the
template literals in the tool files can open and close on a newline.

## Server instructions and titles

The server sends a short orientation as its MCP `instructions` in
`server/discover`, so every chat starts with the rules: where ids come from,
which tool to call first, how to route fitness questions, the whole-body
versus run-only rule, units and time zone, and how to use `update-activity`
safely. The text lives in `apps/server/src/instructions.ts`. Keep it under
1,800 characters. When you rename, add or remove a tool, check the routing
there too: `server.integration.test.ts` fails if the text names a tool that
does not exist.

Every tool, prompt and app resource also has a display `title` (for example
"Running summary" for `get-running-summary`) for hosts that show titles
instead of ids. Titles are outside `tool-surface.lock.json`, like
descriptions.

## intervals.icu tools

| Tool | Description |
| ---- | ----------- |
| `list-activities` | Compact, date-bounded activity list with units; the entry point for finding activity ids |
| `get-activity` | One activity in detail: metrics, load, HR zones, running dynamics, intervals; use after list-activities |
| `get-activity-streams` | Time-series streams for one activity, downsampled to a bounded number of points, including running dynamics |
| `list-gear` | The athlete's gear (shoes) with mileage and retirement status |
| `get-wellness` | Daily wellness (HRV, resting HR, sleep, weight, CTL/ATL/TSB) for a date or range |
| `get-activity-laps` | Laps of an activity, derived from its intervals, with sport-aware pace/speed, GAP, HR, power, cadence |
| `get-running-summary` | get-activity's detail fields for a run plus cadence, HR zone, and running-dynamics assessments, and a lap breakdown |
| `get-running-dynamics` | Ground contact time, vertical oscillation/ratio, step length, and cadence for a run, with VO/GCT target assessments and a per-WORK-interval breakdown |
| `get-activity-zones` | Time spent in each HR and power zone for an activity, from the activity's own recorded zone bounds |
| `compare-activities` | Compare two activities side-by-side: pace, HR, cadence, load, and running dynamics, plus activity2-activity1 differences and an efficiency verdict |
| `get-hill-analysis` | Climb/descent detection with GAP and early-vs-late climb effort drift |
| `get-split-analysis` | Even km splits with a two-halves pacing verdict stated on the clock and grade-adjusted |
| `get-aerobic-analysis` | Aerobic decoupling and efficiency factor, preferring intervals.icu's own values and computing from streams otherwise |
| `get-interval-analysis` | Interval detection with urban-stop-aware rest classification and rep fade |
| `get-best-efforts` | Best times at standard running distances, from intervals.icu's pace curves |
| `get-race-prediction` | Predicted race times from intervals.icu pace-curve points (Riegel) alongside intervals.icu's own critical-speed model, with confidence, source point, and km goal-pace splits |
| `get-athlete-stats` | Run totals (this week, last 4 weeks, this month, YTD) aggregated from list-activities data |
| `get-fitness-trend` | Fitness/fatigue/form (CTL/ATL/TSB), whole-body from intervals.icu wellness or run-only computed locally, with rest/planned-load projection and a solved taper to a target form on a target date |
| `get-training-load` | Weekly running volume and injury-risk warnings, weekly intervals.icu training load and the types it covers, plus current CTL/ATL/TSB |
| `update-activity` | Update an activity's name, description, gear, RPE, or feel, echoing before/after values (write tool) |

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
`structuredContent.description` is always the full text. The text prints
`feel` with its scale, for example "feel 2 (1 strongest to 5 weakest)": on
intervals.icu 1 is the strongest feeling, so a bare 1 is easy to read as the
worst. It prints step length but not `stride_m`, which is the same per-step
distance (see `get-running-dynamics` below).

`get-activity-streams` returns selected streams (`types`, default time,
distance, heartrate, cadence, velocity_smooth, altitude; also available:
latlng, watts, stance_time, vertical_oscillation, vertical_ratio,
step_length) as index-aligned arrays with units. Large activities are
downsampled to `maxPoints` (10-2000, default 120): each bucket reports the
mean of its non-null samples, except time, distance, and latlng, which take
the bucket's last sample. A heart-rate dropout, which intervals.icu sends as
0 bpm, comes from `loadIntervalsStreams` as `null`, so a bucket never
averages it with real samples, and a bucket of only dropout samples is
`null`. `time` is always fetched to size the buckets, but
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

`get-wellness` returns daily wellness: HRV (both `hrv_rmssd_ms` and
`hrv_sdnn_ms`), resting HR, sleep, weight, training load (`ctl`, `atl`,
`ramp_rate`, and `tsb` = ctl minus atl from the unrounded values, each
rounded to 0.1), and the subjective/device fields (readiness, soreness,
fatigue, stress, mood, motivation, `spo2` (%), `respiration`
(breaths/min), comments); `units` names all of these, including `spo2` and
`respiration`. Takes either a single `date` or an `oldest`/`newest` range
(max 90 calendar days inclusive); supplying `date` together with a range is
a validation error. With nothing supplied it defaults to today in the
server's configured time zone. The HRV measure depends on the athlete's
device (docs/api-notes.md). The text prints each HRV value that is present
with its label ("HRV rMSSD", "HRV SDNN", never bare "HRV"). A range's
averages keep the two measures apart. `hrv_note` comes from the data and
never names a device. When SDNN is the only measure, it says that the
values are SDNN, not rMSSD, so rMSSD norms do not apply. Otherwise it names
the measures present, or says that the days have no HRV.

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

`get-running-dynamics` takes the `id` from `list-activities` plus an
optional `includeIntervals` (default `true`) and returns one activity's
running dynamics: activity averages (`stance_time_ms`,
`vertical_oscillation_mm`, `vertical_ratio_pct`, `step_length_mm`,
`stride_m`, `cadence_spm`), `assessments` for vertical oscillation and
ground contact time against the shared 100 mm / 200-260 ms targets
(`status`: `within`/`high`/`low`, plus a human `message` and `target`
string), and `intervals`, one row per WORK interval (`lap_index`, `label`,
`distance_km`, `pace_min_per_km`, and the same dynamics with statuses).
Vertical ratio is reported as a value only, no status. A vertical
oscillation of exactly 100 mm is `high`, "at or above the 100 mm target".
`stride_m` is intervals.icu's distance per step, from pace and cadence, not
a two-step stride; it measures the same thing as `step_length_mm`
(docs/api-notes.md). So the text prints step length only, and
`structuredContent` keeps both. Unlike
`get-running-summary`, a non-step-cadence activity type or one whose device
recorded no dynamics is not an error: `has_dynamics: false` with an
explanatory `message` and empty `intervals`. The text response caps the
interval list at 20 lines; `structuredContent.intervals` always has the
full list. One `get-activity(..., { intervals: true })` call; no streams.

`get-activity-zones` and the `view-activity-zones`/`get-activity-zones-data`
MCP App share one mapper (`mapIntervalsZones`): heart rate from the
activity's own `icu_hr_zones` (upper bounds, zone 1's lower bound is always
0) and `icu_hr_zone_times`, power from `icu_power_zones` and `icu_zone_times`
only when both are present. Unlike get-activity's `hr_zones`, there is no
sport-settings fallback here; pace zones are out of scope (Phase 4). Heart
rate is omitted, with a warning in the text, when the activity recorded
bounds and zone times with different zone counts. The app payload carries
the same warning as `hrZoneWarning`, and the app's empty state shows it. An
activity with no zone data returns a valid empty payload, not an error.

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
`pace_delta_interpretation`. The `efficiency` block is the running efficiency
factor, metres per minute per heartbeat (higher is better), from the same
`speedEfficiencyFactor` (`aerobicAnalysis.ts`) that `get-aerobic-analysis`
reports on the pace basis. It uses grade-adjusted speed (intervals.icu's
`gap`) when both runs have it and moving speed on both sides otherwise, and
`note` names which. A change beyond ±3% reads `improved` or `declined`. It
was pace divided by heart rate before #42, which added a slower pace and a
lower heart rate together instead of cancelling them. The block is
independent of each side's `efficiency_factor` (intervals.icu's own field).
A non-running activity on either side degrades to a warning rather than
failing the call. The app's stream
overlay (`get-activity-streams-raw`) is intervals.icu-backed (see the
activity-chart entry below).

`view-activity-chart`/`get-activity-streams-raw` (activity-chart MCP App)
fetch the activity via `getActivity(apiKey, id, { intervals: true })` and its
streams via `loadIntervalsStreams`, then share one pure mapper
(`buildActivityChartData` in `activityChartData.ts`) with the streams-raw
handler. Streams are jointly downsampled to at most 1,000 points
(`downsampleColumns`); `time`/`distance` are gap-filled so the chart's axes
stay monotonic and gap-free, while every other metric (including running
dynamics: `stance_time`, `vertical_oscillation`, `vertical_ratio`,
`step_length`) keeps `null` samples for the app to draw as gaps. `laps`
carries one band per `icu_intervals` entry (WORK/RECOVERY, not device laps),
with `startIndex`/`endIndex` remapped onto the downsampled `time` array from
the interval's `start_time`/`end_time`, plus `type` and `label` (both
nullable) alongside the existing display `name` ("Recovery" for an unlabeled
RECOVERY interval, else "Lap N"). Cadence stays raw strides/min on the wire;
the app doubles it client-side for step-cadence activity types.

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
(the `all` curve giving the fastest ever at a distance, `90d` the fastest of
the last 90 days) are reduced to one point per run, the run's best by
Riegel's formula. A curve holds a run's best time at every distance it
covered, so without this, one long run counted 40 times, swamped the
consensus and faked the cross-checks behind a "high" grade (#41). The inputs
are combined with Riegel's equivalent-performance formula and weighted by
recency, extrapolation distance, and double for a run intervals.icu marks as
a race. The confidence grade counts runs, not points, and measures an
extrapolation against the longest distance a run covered rather than the
point chosen for it. Each prediction lists its five heaviest contributions
(the consensus, spread and grade use every run), and the text lists the runs
behind them plus a count of the rest: for a year of history with a
half-marathon split table, `structuredContent` went from about 150 KB to
under 20 KB. Alongside each Riegel
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

`get-fitness-trend` computes the classic CTL/ATL/TSB performance-management
chart two ways. Whole-body (default) reads CTL/ATL straight off
intervals.icu's own daily wellness record (`source: "intervals.icu"`),
never recomputed locally, so a custom CTL/ATL time constant configured on the
account is honoured automatically; a day with no recorded CTL/ATL is a gap,
not a zero-load day, and is left out of the series with a warning rather than
corrupting the numbers around it. The window ends at today in the server's
configured time zone, but `as_of` names the most recent date CTL/ATL is
actually known for, which projection and a solved taper are seeded from, and
which can trail today when wellness has not synced yet. `runOnly: true`
computes CTL/ATL locally from the daily sum of `icu_training_load` across
Run/TrailRun/VirtualRun activities only (`source: "computed"`), since
intervals.icu has no per-sport CTL/ATL: it fetches a `days + 150` day runway
and zero-seeds the recurrence so the 42-day average has settled by the
requested window, then trims the displayed series back to it. Both paths
report `activity_types_included` (whole-body: the distinct types with
nonzero load in the window; run-only: the three run types), and whole-body
notes that some types (e.g. strength) may count toward fatigue (ATL) only,
per this athlete's intervals.icu settings. `projectDays` (default 0, or when
`plannedLoads` is given and this is omitted, the days out to its latest date,
capped at 60) projects TSB forward assuming rest, or `plannedLoads`
(`[{ date: YYYY-MM-DD, load }]`, dates after today; unlisted dates in the
projection count as rest; an entry on or before today, or beyond the
projection, is ignored and named in a warning) projects with a specific plan
instead. `targetDate`/`targetTsb` solve a load taper landing on a target
form, unchanged from before. `get-fitness-trend` and the
`view-fitness-trend`/`get-fitness-trend-data` MCP App pair (below) share one
loader (`loadFitnessTrend` in `loadFitnessTrend.ts`) for both the whole-body
and run-only paths, so the app's `runOnly: true` payload is built the same
way as the text tool's and the two can never disagree. The app's payload adds
`source`, `runOnly`, `activityTypesIncluded`, and `warnings` alongside the
series/projection/taper it already carried.

`get-training-load` reports weekly running volume (distance, time,
elevation, run count) and the same injury-risk warnings as before
(`computeWeekWarnings` in `trainingLoad.ts`, shared with the app feed below),
always from Run/TrailRun/VirtualRun activities regardless of `runOnly`. It
also reports weekly `load` (the sum of `icu_training_load` over the included
types) and `load_by_type`, plus the athlete's current CTL/ATL/TSB.
Whole-body (default) sums load across every activity type in the window and
reads CTL/ATL/TSB straight off intervals.icu's own wellness record (`source:
"intervals.icu"`, today or the most recent day with a recorded value; see
`get-fitness-trend` above for why that can trail today).
`runOnly: true` sums load over Run/TrailRun/VirtualRun only and computes
CTL/ATL/TSB locally the same way `get-fitness-trend`'s run-only path does,
through the shared `buildRunOnlyFitnessTrend` helper in `fitnessTrend.ts` and
its `days + 150` day zero-seeded runway, so the two tools can never disagree
(`source: "computed"`). `activity_types_included` names which types `load`
covers either way. The weekly timeline (`aggregateWeeks` in `trainingLoad.ts`,
also shared with the app feed below) spans the union of weeks with a run and
weeks with load: a strength-only week, or a whole-body window with no runs at
all, still gets a row, with run fields zeroed rather than the week being
dropped, so weekly and total load can never differ between this tool and the
app feed for the same activities. Weeks start Monday on each activity's own
local calendar date (`start_date_local`, as intervals.icu reports it, never
re-interpreted through the server's time zone) via `startOfWeekMonday` in
`utils/localDate.ts`, the same helper `get-athlete-stats` uses. Time is
reported both ways: `time_s` (seconds, matching `units.time`) and
`time_hours` (matching `units.time_hours`), per week and in `totals`.

`update-activity` changes an activity's name, description, gear, RPE
(`icu_rpe`), or feel. It always does a fresh read first (bypassing the
cache), writes only the fields that differ from the current value in a
single PUT, never retried even on a 5xx, then does a fresh re-read and
reports `changes: [{ field, before, after }]` for exactly the fields that
were sent. `descriptionMode` is `replace` (overwrites) or `append` (keeps
the existing text and adds the new text below it, separated by a blank
line). With no mode it replaces, but only when no existing text is lost:
the activity has no description (or only whitespace), or the new text
already contains it (compared trimmed). Otherwise the call fails before
the gear check and sends no PUT. The error gives the existing
description's length and first 120 characters, and asks for `append` or
`replace`. When an explicit `replace` drops existing text, the text reply
also quotes the removed text (length and first 120 characters), because
some hosts drop `structuredContent`, where `changes[].before` has it in
full. `gearId` is validated against `list-gear`: an unknown id fails
and lists the available gear ids and names; a retired gear id is accepted
with a warning. Gear can be switched but not cleared; intervals.icu ignores
a null gear id (docs/api-notes.md). Name, description, and RPE writes were
live-verified 2026-09-25 (docs/api-notes.md); `feel` is 1 to 5 on
intervals.icu's scale, 1 the strongest feeling and 5 the weakest. The write
check did not exercise `feel`, but its scale was verified separately in the
intervals.icu web UI (docs/api-notes.md). A
request with nothing left to change after diffing against the
current activity reports "no change" and sends no PUT. Any field whose
re-read value does not match what was sent (e.g. gear not applied) adds a
warning rather than failing the call.

## Visualization tools

Each `view-*` MCP App has an app-only `get-*-data` companion that fetches what
the UI renders. `view-compare-activities`/`get-compare-activities-data`,
`view-activity-zones`/`get-activity-zones-data`,
`view-fitness-trend`/`get-fitness-trend-data`,
`view-training-load`/`get-training-load-data`, `view-activity-chart`/
`get-activity-streams-raw`, `view-cadence-trends`/`get-cadence-trend-data`,
and `view-route-map`/`get-route-map-data` are all ported to intervals.icu.

| Tool | Description |
| ---- | ----------- |
| `view-activity-chart` | Interactive chart with HR, power, pace, altitude, cadence, grade, and running-dynamics overlays; interval bands (MCP App) |
| `get-activity-streams-raw` | Downsampled per-sample streams plus interval bands for the activity chart UI (app-only) |
| `view-cadence-trends` | Interactive cadence trends with timeline, scatter, zones, and overlay views (MCP App) |
| `get-cadence-trend-data` | Summary cadence/pace data for the cadence trends UI (app-only) |
| `view-route-map` | Interactive map of an activity's GPS track, fit to bounds with start/finish markers; optional distance-anchored waypoints (MCP App) |
| `get-route-map-data` | `[lat, lng]` coordinates from the activity's latlng stream plus index-aligned metric streams and WORK-interval end markers for the route map UI (app-only) |
| `view-training-load` | Weekly running-volume bars with a rolling trend line and injury-risk warning weeks (MCP App) |
| `get-training-load-data` | Per-week volume, trend value, warning flags, weekly load, and current CTL/ATL/TSB for the training-load UI (app-only) |
| `view-compare-activities` | Interactive overlay of two activities' streams on a shared distance/time axis with a delta summary (MCP App) |
| `get-compare-activities-data` | Aggregate comparison (summaries, activity2−activity1 differences, efficiency) for the compare-activities UI (app-only) |
| `view-activity-zones` | Time-in-zone bar chart for one activity's HR zones with an easy/moderate/hard split (power zones dropped for now; see docs/api-notes.md) (MCP App) |
| `get-activity-zones-data` | Per-zone time distributions (bucket bounds, seconds, percentages) for the activity-zones UI (app-only) |
| `view-fitness-trend` | CTL/ATL/TSB over time with shaded fatigue/freshness/ramp bands and a dashed taper plan or rest projection past today; a Whole body/Runs only toggle switches scope, caching each side (MCP App) |
| `get-fitness-trend-data` | Per-day CTL/ATL/TSB, the projection, the solved taper, and the dated warning bands for the fitness-trend UI; `runOnly` switches between whole-body (intervals.icu wellness) and run-only (computed) (app-only) |

Every `*-data` app-only tool reads intervals.icu streams through
`loadIntervalsStreams` (see docs/architecture.md#streams) and downsamples to
about 1,000 points for the chart and route-map payloads. The gap-free axes
(time, distance, and route-map lat/lng) are filled before downsampling so
every downstream lookup stays valid; every other metric keeps `null` samples
as `null` (a heart-rate dropout, which intervals.icu sends as 0, is `null`
too), and the chart draws a gap rather than a fabricated zero or spike.
This matters most for the running-dynamics overlays (stance time, vertical
oscillation/ratio, step length), which have interior gaps mid-run, not just
leading/trailing ones (see docs/api-notes.md). `get-cadence-trend-data`
leaves runs with no recorded cadence out of its run list rather than
plotting them at zero.

## Prompts

Reusable multi-step workflows a host can offer as slash commands or starters.

| Prompt | Arguments | What it does |
| ------ | --------- | ------------ |
| `weekly-review` | `weeks` (optional, default 4) | Reviews recent training (load trend, key workouts, cadence patterns), ending with focus points for next week |
| `annotate-last-run` | `activity_id` (optional, defaults to the most recent run) | Analyses a run and appends a short coaching note to its activity description. Confirms before writing |

In Claude Desktop and Claude Code these appear in the prompt picker once the
server is connected. `annotate-last-run` uses a write tool (`update-activity`),
so a client needs to grant it before the prompt can write the note.

## Tool permissions

Every tool declares MCP annotations so a host can tell reads from writes. The
33 read tools set `readOnlyHint: true` and `destructiveHint: false`, which is
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
