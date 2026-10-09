# Tool reference

Everything the server exposes: tools, prompts, permission behaviour, and
example requests. The single home for this catalog — README and AGENTS.md link
here instead of keeping copies.

Tool names and schemas are a published contract: grants are stored per tool
identity, so renames or schema reshapes re-prompt every user. See
[architecture.md](architecture.md#tool-metadata) before changing either.

> **Status.** All tools below talk to intervals.icu directly and are
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
1,800 characters with the longest time zone name it can carry (32 characters,
`America/Argentina/ComodRivadavia`); the integration test measures both the
configured zone and that one. When you rename, add or remove a tool, check the routing
there too: `server.integration.test.ts` fails if the text names a tool that
does not exist.

Every tool, prompt and app resource also has a display `title` (for example
"Running summary" for `get-running-summary`) for hosts that show titles
instead of ids. Titles are outside `tool-surface.lock.json`, like
descriptions.

## intervals.icu tools

| Tool | Description |
| ---- | ----------- |
| `list-activities` | Compact, date-bounded activity list with units; the entry point for finding activity ids; swim pace per 100 m, speed for other sports, achievement types |
| `get-activity` | One activity in detail: metrics, load, HR zones, running dynamics, intervals, gear name, achievements, HR recovery; use after list-activities |
| `get-activity-streams` | Time-series streams for one activity, downsampled to a bounded number of points, including running dynamics |
| `list-gear` | The athlete's gear (shoes) with mileage and retirement status |
| `get-wellness` | Daily wellness (HRV, resting HR, sleep, weight, CTL/ATL/TSB) for a date or range |
| `get-activity-laps` | Laps of an activity, derived from its intervals, with sport-aware pace/speed, GAP, HR, power, cadence |
| `get-running-summary` | get-activity's detail fields for a run plus cadence, HR zone, and running-dynamics assessments, and a lap breakdown |
| `get-running-dynamics` | Ground contact time, vertical oscillation/ratio, step length, and cadence for a run, with VO/GCT target assessments and a per-WORK-interval breakdown |
| `get-activity-zones` | Time spent in each HR zone for an activity, from the activity's own recorded zone bounds |
| `get-athlete-zones` | The athlete's own LTHR, max HR, HR and pace zones, threshold pace and FTP from sport settings, with a check of LTHR and max HR against recent heart rate bests |
| `compare-activities` | Compare two activities side-by-side: pace, HR, cadence, load, and running dynamics, plus activity2-activity1 differences and an efficiency verdict |
| `get-hill-analysis` | Climb/descent detection with GAP and early-vs-late climb effort drift |
| `get-split-analysis` | Even km splits with a two-halves pacing verdict stated on the clock and grade-adjusted |
| `get-aerobic-analysis` | Aerobic decoupling and efficiency factor on a grade-adjusted, pace or power basis from streams, with intervals.icu's own values labelled apart |
| `get-interval-analysis` | Interval detection with urban-stop-aware rest classification and rep fade; with findSimilar, earlier sessions with the same reps |
| `get-best-efforts` | Best times at standard running distances: over your history from intervals.icu's pace curves, or inside one run with where each started |
| `get-race-prediction` | Predicted race times from intervals.icu pace-curve points (Riegel) alongside intervals.icu's own critical-speed model, with confidence, source point, and km goal-pace splits |
| `get-athlete-stats` | Run totals and totals for every sport (count, moving time, distance and whole-body load per activity type) for this week, the last 4 weeks, this month and YTD, aggregated from list-activities data |
| `get-fitness-trend` | Fitness/fatigue/form (CTL/ATL/TSB), whole-body from intervals.icu wellness or run-only computed locally, with rest/planned-load projection and a solved taper to a target form on a target date; `newest` reads a past window, with no projection or taper |
| `get-training-load` | Weekly running volume and volume-spike warnings, weekly intervals.icu training load and the types it covers, plus current CTL/ATL/TSB; `newest` ends the weeks on a past date |
| `update-activity` | Update an activity's name, description, gear, RPE, or feel, echoing before/after values (write tool) |

`list-activities` defaults to the last 28 days (today back to 27 days
earlier) in the server's configured time zone, sorted newest first. Filter
with `type` (`runs` for Run, TrailRun and VirtualRun, or a comma-separated
list such as `Run, Hike`; for the most recent run, pass `id: "latest"` to
the per-activity tool instead) or
`nameContains` (case-insensitive substring), and cap the page with `limit`
(1-200, default 30). `search` (a name substring or `#tag`) reaches all
history through `search-full`, beyond the 366-day window, with `type`,
`oldest` and `newest` as post-filters and `nameContains` ignored. Every
entry carries `tags` and `race`. It also carries `achievement_types`: the
intervals.icu achievement types the activity set (`achievements.ts`), empty
when none; the text names them after the load, a threshold type with the
activity type ("Swim LTHR up"), because a threshold belongs to one sport. Swim and OpenWaterSwim
entries carry `pace_min_per_100m`, and every other sport that is not a run
and has a distance carries `speed_kmh`. Both come from `sportSpeed`
(`utils/running.ts`), from distance over moving time. A page that
would overrun the response size budget (a year of daily activities at limit
200) comes back shorter, with `truncated: true`; whenever the list is
truncated, the text names the `oldest`/`newest` call that fetches the older
matches. A truncated search names the call with `search` and `newest` (and
`oldest` when one was given). A search returns at most 200 matches; when it
hits that cap the text says to narrow the query or add `oldest`/`newest`. An
activity
synced into intervals.icu from Strava (`source: "STRAVA"`) is a stub: the
intervals.icu API has no further detail for it, so the response flags it with
`is_strava_stub` and the text response adds a trailing note. That detection
is unverified against a real Strava-sourced activity; see docs/api-notes.md's
Strava stub spike note.

`get-activity` takes the `id` from `list-activities` and returns core
metrics, training load, HR zone time-in-zone, running dynamics (Run,
TrailRun, VirtualRun, Walk, Hike, with device support), the WORK/RECOVERY
interval breakdown (`includeIntervals`, default true), gear id and name,
and description, all with units. The gear name comes from the athlete's
gear list, read through the 10-minute cache (list-gear's source), because
the activity sends only the gear id. When the id is not in the cached list
(gear added since it was cached), it reads the list once more past the
cache. A failed gear read leaves `gear_name` null and never fails the call;
an activity with no gear sends no gear read. `achievements` lists the bests
and threshold rises intervals.icu marked (`type`, its own `message`,
`value`, effort `duration_s`, `distance_m`, `watts` and `pace_mps`, all as
sent); only `LTHR_UP` is verified live. An LTHR_UP's `value` is the LTHR
intervals.icu estimated from the effort, not proof that the sport settings
changed, and the text names the activity type ("Swim LTHR up: N bpm
estimated (1h at N bpm)"), because a swim's LTHR is not the run's. The
description sends PB questions to `get-best-efforts`: no pace best has been
seen in `achievements` live. `hr_recovery` is intervals.icu's heart-rate
recovery over a window it picks (60 s on every activity checked; it can
start before an effort ends): `drop_bpm`, `start_bpm`, `end_bpm`,
`window_s`, `start_time_s`, or null. The text prints the achievements after
the metrics line and the HR recovery after the load line. Pool swims also
report `lengths` and `pool_length_m`. HR zone boundaries come from
the activity's own recorded `icu_hr_zones` when present (any activity
type), the same source `get-activity-zones` reads; otherwise they fall back
to the athlete's Run sport settings group (`types` Run, VirtualRun,
TrailRun) when that group covers the activity's type. `hr_zones` is an
empty array when neither source is usable, rather than failing the call.
`resolveHrZones` (`activityZones.ts`) holds this rule, shared with
`get-running-summary`.
`pace_min_per_km` and `gap_min_per_km` (grade-adjusted pace, derived
from the activity's `gap` field, which intervals.icu reports in m/s, the
same unit as `average_speed`) are set for Run/TrailRun/VirtualRun only: a
Walk or Hike gets a cadence but no pace. Swims get `pace_min_per_100m` and
every other non-run sport with a distance gets `speed_kmh` (Walk and Hike
included), at activity and interval level, from `sportSpeed`. Ground
contact time, vertical oscillation and step length show only for Run,
TrailRun, VirtualRun, Walk and Hike, on intervals too: on a swim,
intervals.icu's step length is about half a stroke, not a step
(docs/api-notes.md). A swim interval's moving time includes its rests at
the wall, while the activity's leaves them out, so an interval's
`pace_min_per_100m` can be slower than the activity's; the interval header
in the text says so. The text response truncates
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
and drop `structuredContent`. The response is held to the size budget (see
docs/architecture.md): a high `maxPoints` with many types returns fewer
points than asked, `returned_points` says how many, and the text says it was
reduced. A 4 h run at `maxPoints` 2000 returns about 600 points with the
default types and 250 with all of them.

`list-gear` returns each gear item's distance (km, including any starting
distance entered in the UI when it was added, not just distance logged
through activities), activity count, retirement status, and any usage
reminders. Retired gear is excluded by default (`includeRetired`, default
false). An account with no gear returns `count: 0` and a message pointing to
the intervals.icu Gear page.

`get-wellness` returns daily wellness: HRV (both `hrv_rmssd_ms` and
`hrv_sdnn_ms`), resting HR, sleep, weight, training load (`ctl`, `atl`,
`ramp_rate`, and `tsb` = ctl minus atl from the unrounded values, each
rounded to 0.1, through the same `ctlAtlTsb` as `get-fitness-trend`), and the subjective/device fields (readiness, soreness,
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
field, not the locally-modelled GAP hill/split analysis compute); swims
report `pace_min_per_100m` and other distance sports `speed_kmh`, both from
`sportSpeed` (distance over moving time), so they match `get-activity`'s
intervals. A swim lap's moving time includes its rests at the wall, so the
text adds a note that swim paces include them. Cadence is spm
(doubled from strides) for Run/TrailRun/VirtualRun/Walk/Hike, rpm otherwise,
with the unit named in `units.cadence`. The response also carries
`device_lap_count` (`icu_lap_count`) and `intervals_edited`
(`icu_intervals_edited`); the text flags it when intervals were edited or
the interval count differs from the device's lap count. An activity with no
intervals returns a valid payload with `lap_count: 0`.

`get-running-summary` takes the `id` from `list-activities` and is a thin
wrapper over `get-activity`'s mapper: every field `get-activity` returns
(gear name, achievements and HR recovery included; the text prints the last
two after the metrics and load lines), plus a `cadence_assessment` (from `average_cadence_spm`), an `hr_zone_summary`
(time and percent per zone), a `dynamics_assessment` (vertical oscillation
and ground contact time against the 100 mm / 200-260 ms targets, only when
`running_dynamics` is present), and `laps` (from the same interval mapper as
`get-activity-laps`). No power fields. `hr_zone_summary` prefers the
activity's own recorded `icu_hr_zones` as zone bounds, falling back to the
Run sport settings group only when its `types` names this activity's type;
it is `null` (with `hr_zone_note` explaining why) when no bounds match the
recorded zone time count. Only Run, TrailRun, and VirtualRun are accepted;
any other type is rejected with a message naming the type and pointing to
`get-activity`. The text response caps the lap list at 20 lines and names
`get-activity-laps` for the rest; `structuredContent.laps` always has the
full list.

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
interval list at 100 lines (no other tool returns per-interval dynamics, so
it is generous rather than a pointer); `structuredContent.intervals` always has the
full list. One `get-activity(..., { intervals: true })` call; no streams.

`get-activity-zones` and the `view-activity-zones`/`get-activity-zones-data`
MCP App share one mapper (`mapIntervalsZones`): heart rate from the
activity's own `icu_hr_zones` (upper bounds, zone 1's lower bound is always
0) and `icu_hr_zone_times`. Power zones are dropped for now (docs/api-notes.md).
Unlike get-activity's `hr_zones`, there is no
sport-settings fallback here; pace zones are out of scope (Phase 4). Heart
rate is omitted, with a warning in the text, when the activity recorded
bounds and zone times with different zone counts. The app payload carries
the same warning as `hrZoneWarning`, and the app's empty state shows it. An
activity with no zone data returns a valid empty payload, not an error.

`get-athlete-zones` returns the athlete's own zones and thresholds from
intervals.icu sport settings: LTHR and max HR (bpm), HR zones, threshold
pace, pace zones and FTP (W). `sport` (default `Run`) picks the settings
group. It is matched against each group's `types`, ignoring case and spaces,
so `TrailRun` and `trail run` both give the Run group. One request reads
every group (`GET /athlete/{id}/sport-settings`). A sport that no group lists
gets intervals.icu's default Other group (`default_group: true`), as
intervals.icu does itself, but only when it is an intervals.icu activity type
(`intervalsActivityType`, from the `SportSettings.types` enum); a word such
as `Running` or `Cycling` is an error that lists the groups' types, because
intervals.icu answers 404 for it. The text says so and lists the other
groups. Zone
ranges come from `zoneRanges` (`activityZones.ts`), the rule every zone tool
uses: zone 1 starts at 0, and each later zone starts above the previous
zone's upper bound. A heart rate is in the first zone whose upper bound is
at or above it. This rule gives intervals.icu's own zone times exactly
(docs/api-notes.md). intervals.icu stores `threshold_pace` as a speed in m/s.
The tool gives it in m/s and as pace per km for every group, and as pace per
100 m for a swim group (`threshold_pace_min_per_100m`, through
`speedDisplay`). Pace zones are percentages of threshold speed, with the
slowest and fastest pace of each zone (per km, and per 100 m for a swim
group). Zone 1 has no slow limit, and the top zone (999%) has no fast limit.
The text gives a swim group's paces per 100 m. Power zones are not covered.

The tool then reads intervals.icu's HR curves for the same sport (`90d` and
`1y`, one request) and checks two settings. LTHR: intervals.icu's own rule,
the higher of the best 60-minute heart rate and 98% of the best 20-minute
heart rate, both of the last 90 days. intervals.icu's `LTHR_UP` achievements
follow this rule on every probed case (docs/api-notes.md). The 30-minute
best is not used: a hard 10 km race can hold a 30-minute heart rate above a
correct LTHR, and the hint would then disagree with intervals.icu. Max HR:
the best 60-second heart rate of the last year. 60 s, because optical sensor
spikes inflate 1 to 5 s peaks; a year, because max HR falls with age and an
all-time peak can be years old. An estimate above the setting gives
`status: "above"` and a hint that the setting may be out of date. The hint
names the activity, so the athlete can check it for a sensor error first. An
estimate at or below the setting is `not_above`. This does not show that the
setting is too high, only that the estimate from the heart rate bests is not
above it, so the tool never calls a setting too high. Only an `above` message
calls the number an LTHR estimate. A 20- or 60-minute best under half of
the higher of max HR and the best 60-second heart rate (sensor dropouts, sent
as 0) is not used: the check is `unknown` and the message names the best. `estimate_bpm` and `basis` (the curve point behind
it) are set whenever they are known. `hr_bests` lists the 20-, 30- and
60-minute bests of the last 90 days and the 60-second best of the last
year. The Other group gets no check, because intervals.icu returns the Run
curve for its types. A failed HR curve read does not fail the call: the
zones return, both checks are `unknown`, and `warnings` says why
(`unavailableReason`).

`compare-activities` and the `view-compare-activities`/`get-compare-activities-data`
MCP App's summary half share one `buildComparison(a, b)`, so text and app
output can never drift. Each side reports the same fields `get-activity`
does for one activity: `pace_min_per_km`/`gap_min_per_km` as `m:ss` strings
(`gap_source: "intervals.icu"`), training load (`icu_training_load`),
decoupling, efficiency factor, and running-dynamics averages when the
device recorded them. A swim side carries `pace_min_per_100m` and another
non-run side `speed_kmh`, from the same `sportSpeed`; the pace difference
and the efficiency block stay run-only. The pace delta comes from each activity's raw
distance and moving time, never from the formatted per-side paces, so two
roundings cannot compound; the distance, HR, cadence and elevation
differences subtract the per-side summary values (off by at most one
rounding step). The pace delta renders as `pace_delta_min_per_km` (signed `m:ss`)
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

An activity with no streams (a manual entry; `IntervalsStreamsUnavailableError`
from `loadIntervalsStreams`, the one error these handlers degrade on, as
`get-route-map-data` does) is not an error (#65). `get-activity-streams-raw`
returns `emptyActivityChartData`: the usual `activityId`/`activityType`/`name`,
`streams: { time: [] }`, `laps: []` and `noStreams: true`.
`view-activity-chart` reads the streams itself (usually a cache hit for the
app's own call afterwards; a 404 is not cached) and adds "No recorded streams;
the chart has nothing to plot." to its text, or "This activity has no recorded
streams." for a host that cannot render the app, whose footer then names
`get-activity` instead of `get-activity-streams`. A rate limit or any other
failure still propagates.

`get-hill-analysis` and `get-split-analysis` both read their streams through
the shared intervals.icu stream adapter (`distance`, `altitude`,
`grade_smooth`, `heartrate`, `velocity_smooth`, `cadence`, plus a derived
`moving` flag) and share one grade/GAP implementation
(`gapFactor`/`computeGrades` in `hillAnalysis.ts`): grade prefers
intervals.icu's `grade_smooth` stream, falling back to an altitude-window
derivation when it is absent or entirely null, and `grade_source` in the
response names which was used. An altitude stream with no real samples
counts as no altitude, not as flat ground. GAP applies the Minetti factor to
grade averaged over a centred 100 m window (`gapGrades`), clamped to ±30%,
never to the raw per-sample grade: the curve is convex, so zero-mean grade
noise applied per sample made GAP too fast (±10% noise, 13% too fast on the
flat). When the raw grade swings more than 3 points (RMS) around that
average, both tools add a warning that the elevation track is noisy and GAP
is approximate. A null sample in `distance`/`altitude`/grade
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
climbing cost more late in the run. With no elevation data (no grade stream
and no real altitude samples) it returns an error. Climb detection still
reads the per-sample grade, not the 100 m average.

`get-split-analysis` bins the streams into fixed 1 km splits (device laps
are ignored) and states a two-halves verdict twice: once on the clock, once
grade-adjusted, cut at the exact midpoint of recorded distance rather than
by grouping splits. `terrain_pct` names how many percentage points of the
raw change the terrain accounts for, so a hilly back half is not misread as
fade and a course that flattens out does not hide real fade. With no
elevation data, `grade_source` is `none`, every grade-adjusted field
(`gap_pace_*`, `gap_shape`, `gap_delta_pct`, `terrain_pct`) is null, and the
verdict is on the clock only. On a noisy elevation track the interpretation
also says the grade-adjusted part is approximate. `totals.elevation_gain_m`
is the activity's own `total_elevation_gain` (`elevation_gain_source:
"intervals.icu"`, the value `get-activity` reports) when it has one, else
the ascent summed from the altitude samples with a 3 m hysteresis
(`computed`), else null. It once added each split's net change, so a km
that climbed 20 m and descended 20 m added 0 (136 m against
`get-activity`'s 693 m on one marathon, #45).

`get-aerobic-analysis` computes decoupling and efficiency factor from
streams on one `basis`: `gap` reads `velocity_smooth` corrected for grade
(`gradeAdjustedSpeeds` in `hillAnalysis.ts`, the same 100 m averaged grade
and Minetti factor as the hill and split tools), `pace` reads raw
`velocity_smooth`, `power` reads `watts`. On raw pace, terrain reads as
fitness: an out-and-back at a steady 150 bpm, 2.8 m/s up a 1.8% grade and
3.4 m/s back down, decouples by -19% one way round and +16% the other; on
`gap` both are about 0% (#74). With no elevation data, `gap` falls back to
`pace` with a warning, and `basis` in the response says `pace`. When the
caller passes no `basis` and no `includeBreakdown`, and the activity
carries both of intervals.icu's own `decoupling` and
`icu_efficiency_factor`, the tool reports those without a stream fetch
(`decoupling_source`/`efficiency_factor_source: "intervals.icu"`), with
`basis: null` and no efficiency unit: intervals.icu does not say which basis
it used (docs/api-notes.md). In every other case both numbers are
`computed` (the default basis is `gap`), and intervals.icu's values, when
the activity has any, are in a separate `intervals_icu` field and a
separate text line, never labelled with the computed basis. Pace figures
render as a bare
`m:ss` string in `avg_pace_min_per_km`/`normalized_pace_min_per_km`
(grade-adjusted on `gap`), never miles. On the power basis a recording
device name starting
with `Watch` (an Apple Watch) adds a warning that the power stream is
Apple's own estimate, not a power meter reading. Warm-up exclusion defaults
to the activity's `icu_warmup_time`, then the athlete's Run sport-settings
`warmup_time`, then 5 minutes; intensity factor's threshold power defaults to
the athlete's Run sport-settings `ftp`, then the activity's `icu_ftp`.

`get-interval-analysis` classifies every stopped segment (from the derived
`moving` stream) before trusting it as interval structure: under 60 s with no
fast effort before it is a traffic light (excluded), up to 3 min after a fast
effort is genuine recovery, over 5 min is a café/regroup stop (excluded),
anything else is unclassified and lowers confidence. Each stop is judged by
the work segment that ends right before it. A stop before any movement (a
standing start while the watch finds GPS) is not a rest: it is left out of
`rests`, and the reasoning names it. When the activity
carries clean structured intervals.icu laps (`icu_intervals`, WORK/RECOVERY)
those are preferred over stream reconstruction; they also catch
jog-recovery sessions, which never stop moving. Sliver laps (under 50 m or
15 s, such as the 0 m lap an Apple Watch often records at the end) are
ignored. A lap is fast at 1.08 times the median lap speed or more;
consecutive fast laps merge into one rep, and it takes at least 2 reps with
slower laps between them. The laps fall back to streams when the reps'
speeds are not tightly clustered (rain, sweat). On an auto-lap set (most
laps 1 km or 1 mile) a fast lap is often a downhill km, so the laps count
only when intervals.icu's labels match (every fast lap WORK, every lap
between RECOVERY) or there are 3 reps each at least 1.15 times the speed of
the laps between. Labels that do not match the fast laps lower confidence.
At the outer edge of the first and the last fast block, a lap slower than
80% of the other blocks' median speed (about 25% slower pace) is a warm-up or
cool-down lap, not part of a rep. This happens when the recoveries are walks: the median lap is
slow, so a steady lap reads as fast. With 3 or more blocks such laps are
dropped before the consistency check, and the reasoning says so (#84). A
first or last rep that slow is dropped the same way, so the fade then reads
only the other reps. Each rep from laps also carries
intervals.icu's interval `intensity` (`intensity_pct`, time-weighted across
its laps): a percent of the sport's threshold, heart rate or pace per the
athlete's settings (docs/api-notes.md).
Work reps are reconstructed between
recoveries, merging straight through traffic lights, and reported with
per-rep pace (`pace_min_per_km`, bare `m:ss`), HR, cadence, and power; fade compares the last rep
against the first. An HR-distribution tiebreaker ("was this a workout at
all") reports the share of moving time at ≥ 88% of the athlete's max HR:
the activity's `athlete_max_hr`, else the top `icu_hr_zones` bound
(`hr_signal.max_hr_source`). It used the run's own peak, and on an easy run
the peak is low, so an easy zone 2 run read as "a hard workout" (#47). When
the activity has neither, the peak is a last resort: the response warns,
and the signal makes no call and does not change the verdict.

With `findSimilar: true`, `get-interval-analysis` also finds earlier
sessions with the same reps, to track progress on a repeated workout. It
takes this session's typical reps: the reps within 20% of the median rep
time. With fewer than 2 (a pyramid) it returns `mixed_reps`, and a
non-interval session returns `not_intervals`; neither makes a request. It
asks intervals.icu's interval search for activities with reps of that time
(widened by 15%) and intensity (the reps' own intervals.icu intensity,
widened by 5 points; any intensity when the reps have none), and a rep count
within 40% (at least 2 either way). The search covers every sport, but it returns only the 100 newest matches
(a full page of later sessions or other sports leaves no candidate, and the
reason says so), also matches recovery intervals, and its count rule does not
follow the current laps (docs/api-notes.md), so its rows are only
candidates. The tool keeps earlier sessions of the same sport (Run,
TrailRun and VirtualRun count as one), reads the 20 newest in one bulk
request with their intervals, and checks each one from its own laps with
the lap rules above. A candidate matches when its typical rep time is
within 15% of this session's and its typical rep count is within the same
tolerance. Up to 5 matches come back, newest first, with rep count, typical
rep distance and time, mean rep pace (total time over total distance),
time-weighted HR and intensity, fade (last typical rep against the first),
and the change in pace and HR against this session. A session whose laps
show no clean reps is skipped and counted, so a workout with no lap per rep is
never found. If the search or the bulk read fails, the analysis still comes
back, with `similar.status: "unavailable"` and the cause. The cost is up to two
more requests.

`get-best-efforts` reports best times at standard distances (400m, 1km, 5km,
10km, half marathon, marathon by default, or a subset via `distances`).

Over your history it reads intervals.icu's athlete pace curve. `window` picks
`all`, `1y` (default), `90d`, or a custom `YYYY-MM-DD..YYYY-MM-DD` range,
mapped to the matching curve id. With no `window` and no `id`, the other
windowed tools' `oldest`/`newest`/`days` are read as a range (see
docs/architecture.md, Input validation). `topN` (1-5, default 1) picks how many
distinct activities to report per distance. The call is always one request:
with `topN` above 1 it adds `subMaxEfforts=topN-1`, and intervals.icu returns
the next-best times from other activities, with their names, dates and race
flags in the same response (#82). Before, ranks below 1 cost a per-activity
curve read and one `getActivity` call per winning activity, up to 30. Each
requested distance is matched to the nearest curve point, but only within
tolerance (2% of the target or 50 m, whichever is larger). A distance with no
point that close comes back as an empty list, named in `missing`, with a
warning; a short window's only 5K is never reported as its marathon time.
`distance_m` gives the distance each time covers, and the text names the
curve point when it is not the label's distance.

With `id` (an activity id or `"latest"`; not with `window`) it searches that
one run: two requests, the activity and its streams (time, distance and
smoothed speed), plus the activity-list read that resolves `"latest"`.
`bestEffortWindows` (`activityBestEfforts.ts`) finds the fastest stretch at
each distance with the pace curve's own rule, so rank 1 equals intervals.icu's
activity pace curve (docs/api-notes.md). `topN` picks the fastest stretches
that do not overlap. Each entry adds `start_km` and `end_km` (from the run's
first distance sample) and `stopped_seconds`: an auto-pause gap, or a sample
under 0.5 m/s, the same stops as `get-split-analysis`. With no `distances`,
only the distances the run covers are searched, and a distance the run is
just short of (within the window tolerance, such as a GPS-short parkrun) gets
a warning. A distance you ask for that is longer than the run is empty, in
`missing`, with a warning. `covered_km` is rounded down, so a run 3 m short
of 5 km reads 4.99 km. Parts marked in intervals.icu to ignore for pace are
left out, with a warning; a distance with no stretch outside them is in
`missing`. If the stream loader dropped a sample with no time, the part
positions are not certain, so the parts are not left out and the warning
says so. A run marked to ignore its pace gets a warning that intervals.icu
may leave it out of the pace curves (not verified, docs/api-notes.md). Only
Run, TrailRun and VirtualRun are searched, and an activity with no recorded
streams returns an error.

Every time is the elapsed time across the stretch, the rule intervals.icu's
pace curves use, so a stop inside the stretch counts (verified 2026-10-08,
docs/api-notes.md). The response's `note` says so. Before #82 the tool called
it a moving-time curve; that was wrong. Pace is a bare `m:ss` string in
`pace_min_per_km`, never miles.

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
(optional; `5km`, `10km`, `15km`, `10 mile`, `half marathon`, `marathon` or
`50km`, "5K" style still accepted) adds a km split table (even and negative-split) for that race, and
`goalTime` paces it to a goal instead of the prediction. Output is km only, no
mile paces or splits. Pace is a flat `pace_sec_per_km`/`pace_min_per_km` pair
(bare `m:ss`), matching every other tool, wherever a prediction, the goal
target, or a split row reports one; `units.distance` is `"m"`, matching the
`distance_m` fields the response actually carries.

`get-athlete-stats` takes no inputs. It reports four periods: this week
(Monday to today), the last 4 weeks (today and the 27 days before it), this
month and the year to date, all in the server's time zone. It reads every
activity in one client read of `/athlete/{id}/activities` (31-day windows,
no row cap), from 1 January or 27 days back, whichever is earlier. It builds two sets of totals from the same rows. The
run totals (`this_week`, `last_4_weeks`, `this_month`, `ytd`) count Run,
TrailRun and VirtualRun only: run count, distance, moving time, elevation
gain, run-only load and average pace (total distance over total moving
time). `all_sports` has the same four periods over every activity type.
Each period has `by_type`, keyed by the intervals.icu type name, with
`count`, `moving_time_s`, `distance_km` and `load`. It also has a `total`
with `count`, `moving_time_s` and `load`. Each `total` field is the sum of
the `by_type` rows, so the type loads add up to the whole-body load. On
the account checked, that load equalled the sum of intervals.icu's wellness
`atlLoad` over the same dates (docs/api-notes.md, "Per-sport totals").
Strava stubs and uploads that wellness has not caught up with can make them
differ. `total` has no distance,
because a sum of run, ride and swim kilometres has no training meaning.
`distance_km` is null for a type with no distance above 0, such as
WeightTraining or Pilates. An activity with no load adds 0 to `load`. Types
are ordered by load (highest first), then by moving time, then by name. The
text lists them in the same order, under its own "All sports (whole-body
load)" header. TrailRun and VirtualRun keep their own rows, so the run rows'
count, moving time and load add up to the run totals (distance can differ
by rounding). One sport can have several types, such as Swim and
OpenWaterSwim: add their rows for a sport total. Activities synced from Strava
(`source: "STRAVA"`) are left out of both sets: the API gives no data for
them (docs/api-notes.md, Strava stub spike). The spec's type enum lists 60 activity
types (`Activity.type` itself is a plain string), so the response has an
upper bound: every type in every period is
about 32,000 characters, under the response size budget.

`get-fitness-trend` computes the classic CTL/ATL/TSB performance-management
chart two ways. Whole-body (default) reads CTL/ATL straight off
intervals.icu's own daily wellness record (`source: "intervals.icu"`),
never recomputed locally, so a custom CTL/ATL time constant configured on the
account is honoured automatically; a day with no recorded CTL/ATL is a gap,
not a zero-load day, and is left out of the series with a warning rather than
corrupting the numbers around it. The window ends today in the server's
configured time zone, or on `newest` (YYYY-MM-DD, today or earlier), and
`days` counts back from that day. `resolveWindowEnd` (`utils/localDate.ts`)
refuses a `newest` after today before any fetch: intervals.icu's wellness
rows after today hold its own projection from planned workouts, not records
(docs/api-notes.md). A `newest` equal to today is the same call as no
`newest`. A window that ends before today is a past block:
`period.ends_today` is false, there is no projection and no taper,
`projectDays`, `plannedLoads` and `targetDate` are ignored (`targetDate` is
not checked, and `plannedLoads` gets no warnings), and the first warning
says so. The text heads the last values "End of window" instead of
"Current", and names the 7-day change "7 days to DATE". `as_of` names the
most recent date CTL/ATL is actually known for in the window, which
projection and a solved taper are seeded from, and which can trail today
when wellness has not synced yet. In a past window a trailing day with no
wellness is reported only as a gap. `runOnly: true`
computes CTL/ATL locally from the daily sum of `icu_training_load` across
Run/TrailRun/VirtualRun activities only (`source: "computed"`), since
intervals.icu has no per-sport CTL/ATL: it fetches a `days + 150` day runway
that ends on the window's last day (today, or `newest`) and zero-seeds the
recurrence so the 42-day average has settled by the requested window, then
trims the displayed series back to it. Both paths
report `activity_types_included` (whole-body: the distinct types with
nonzero load in the window; run-only: the three run types), and whole-body
notes that some types (e.g. strength) may count toward fatigue (ATL) only,
per this athlete's intervals.icu settings. `projectDays` (default 0, or when
`plannedLoads` is given and this is omitted, the days out to its latest date,
capped at 60) projects TSB forward assuming rest, or `plannedLoads`
(`[{ date: YYYY-MM-DD, load }]`, dates after today; unlisted dates in the
projection count as rest; an entry on or before today, or beyond the
projection, is ignored and named in a warning) projects with a specific plan
instead. `tsb_positive_date` (only with a projection) is today when TSB is
already ≥ 0 today, and the text says "already positive today"; otherwise it is
the first projected date TSB reaches 0, or null. `targetDate`/`targetTsb`
solve a load taper landing on a target form. `targetDate` must be a real
calendar date, after today, and at most 180 days ahead (`MAX_TAPER_DAYS`);
any other date is an error before any fetch, in this tool and in the app
pair. `bands` date the deep-fatigue, fresh and steep-ramp stretches. A fresh
band starts at TSB +15 and holds until TSB drops below +12; fresh bands 2
days apart or less merge, and a fresh band needs 3 days unless it runs to the
last day. A band that runs to the last day has a present-tense reason ("now")
and is also in `flags`; a band that ended earlier has a past-tense reason.
A band that runs to the last day of a past window has a dated reason, not a
present-tense one: deep fatigue "… to DATE, the end of the window", fresh
"… on DATE, the end of the window", and a steep ramp "in the 7 days to
DATE". When wellness stops before the window's end, the reason calls that
day "the last day with data in the window". The band is still in `flags`.
`get-fitness-trend` and the
`view-fitness-trend`/`get-fitness-trend-data` MCP App pair (below) share one
loader (`loadFitnessTrend` in `loadFitnessTrend.ts`) for both the whole-body
and run-only paths, so the app's `runOnly: true` payload is built the same
way as the text tool's and the two can never disagree. The app's payload adds
`source`, `runOnly`, `activityTypesIncluded`, `warnings`, `endDate`
(the window's last day, so the app can show "already positive today"),
`endsToday` (false for a past window), and `ctl7dDelta`
(the same `ctlDelta` value as `trend.ctl_7d_delta`, by date, so the app's
narration and the text tool agree on a series with gaps) alongside the
series/projection/taper it already carried.

`get-training-load` reports weekly running volume (distance, time,
elevation, run count) and volume-spike warnings (`computeWeekWarnings` in
`trainingLoad.ts`, shared with the app feed below),
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
also shared with the app feed below) runs from the first week with a run or
load to the current week: a strength-only week, or a whole-body window with no
runs at all, still gets a row, with run fields zeroed rather than the week
being dropped, and so does every week after the last activity, so a layoff
that is still going on shows as zero weeks. Weeks before the first activity
are left out, because they may be missing data (a new account, say). So weekly
and total load can never differ between this tool and the app feed for the
same activities. Weeks start Monday on each activity's own
local calendar date (`start_date_local`, as intervals.icu reports it, never
re-interpreted through the server's time zone) via `startOfWeekMonday` in
`utils/localDate.ts`, the same helper `get-athlete-stats` uses. Time is
reported both ways: `time_s` (seconds, matching `units.time`) and
`time_hours` (matching `units.time_hours`), per week and in `totals`.

The window is whole weeks (`trainingLoadWindow` in `trainingLoad.ts`, shared
with the app feed): `days` rounded up to Monday-to-Sunday weeks in the
athlete's time zone, to the week that holds the window's last day (today, or
`newest`, below). By default the last week is the current week so far, so
`days: 28` reads 4 complete weeks and this week on every weekday, Sunday
included. `period` reports that window, and `period.days` is its length,
which can be up to 13 days more than the requested `days`. Only the last
week can be partial: the week in progress, which the text marks "in
progress, N of 7 days", or a week cut off at a past `newest` (below). The
partial week gets a line in `warnings` (#43). Averages, the trend and the
warnings read the weeks `selectRunWeeks` picks, the one call this tool and
the app feed both make, so their warnings cannot differ: every week from the
first week with a run to the last week, with zero-run weeks kept, those
after the last run included (a layoff is a real gap, even one that is still
going on), and weeks before the first run left out. Neither end depends on
load-only activities, so `runOnly` does not change which weeks the run
numbers read. Averages and the trend use its complete weeks only; with no
complete week yet, the averages are the partial week. The trend compares the distance of the last 2 complete weeks with the 2
before, and the text names the four weeks; when all four have no running
volume, it says so instead of reporting too little data.

`newest` (YYYY-MM-DD, today or earlier; a later date is an error before any
fetch) ends the window on a past date, and `days` counts back from it. The
last week read is the week holding `newest`. When `newest` is a past Sunday,
that week is complete and is one of the `days` weeks, so `days: 84` with a
Sunday reads exactly those 12 weeks. Any other past `newest` leaves its week
partial (Monday to `newest`): it is treated like the current week (left out
of the averages and the trend, flagged only on the volume it has), and the
text calls it "partial", not "in progress". Today's week is in progress even
on a Sunday, because today is not over. CTL/ATL/TSB are as of the window's
last day with data, the text heads them "End of window", and the first
warning says the window is a past block. `period.ends_today` is false for a past window.
A `newest` equal to today is the same call as no `newest`.

A warning fires when a week's distance is over 1.5 times the average of the
4 complete weeks before it: the acute:chronic ratio (#60). The reason gives
both distances, the ratio and how many weeks the average has. The average
needs at least 3 weeks, and an average of 0 km (4 weeks with no runs) gives
no ratio and no warning. The tool also reads the runs of the 4 weeks before
the window (`baselineStartDate` to `startDate` in `trainingLoadWindow`), so
the first weeks of the window have an average too. Those weeks are only the
baseline: they get no row, no total and no warning, and weeks before the
first run in them are left out, like the weeks before the first run in the
window. This is the only rule. A rise of over 30% on the week before used to
fire too, and it warned about a normal week after a recovery or taper week
(40 km after a 10 km week was "increased 300%"). Against the 4-week average
that week is 1.23. A separate "unusually high" rule (over 150% of the average
up to the week, and over 30 km) is gone as well: it flagged the same weeks a
second time. The 1.5 threshold is the top of the usual 1.3 to 1.5 caution
zone. The evidence for any ratio threshold is weak, so the reason says
"volume spike", not injury risk. The average never looks ahead, so a layoff
cannot make the weeks before it look high. The week in progress is never
part of an average, and it is flagged only on the volume it already has
("so far" in the reason). The run-only runway still counts `days + 150` days
back from the window's last day (today, or `newest`), so `current` matches
`get-fitness-trend`'s run-only value for the same `newest`; it already
covers the 4 baseline weeks.

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
intervals.icu's scale, 1 the strongest feeling and 5 the weakest (verified
2026-09-26 in the intervals.icu web UI, docs/api-notes.md). A
request with nothing left to change after diffing against the
current activity reports "no change" and sends no PUT. Any field whose
re-read value does not match what was sent (e.g. gear not applied) adds a
warning rather than failing the call.

## Activity ids

Every activity-id input except `update-activity`'s accepts either a numeric id
(from `list-activities`, e.g. `"i189807578"`) or the special value `"latest"`,
including both ids of compare-activities and the app tools. The `"latest"` value
means the newest Run, TrailRun, or VirtualRun in the last 366 days. It is
resolved once per call by `resolveLatestIds` (`latestActivity.ts`) in
`dispatchToolCall` after validation, walking 31-day windows newest first and
stopping at the first run, from cached `listActivities` reads. If no run is found,
the tool returns an `isError` result naming the fix. `update-activity` cannot use
`"latest"` because a write must name its specific target; it validates against
digits only. The result's `_meta["intervals-mcp/resolvedArgs"]` carries the
ids a `"latest"` resolved to (`id`, or `activityId1`/`activityId2`); the apps
pin their arguments to it (docs/mcp-apps.md).

## Visualization tools

Each `view-*` MCP App has an app-only `get-*-data` companion that fetches what
the UI renders. `view-compare-activities`/`get-compare-activities-data`,
`view-activity-zones`/`get-activity-zones-data`,
`view-fitness-trend`/`get-fitness-trend-data`,
`view-training-load`/`get-training-load-data`, `view-activity-chart`/
`get-activity-streams-raw`, `view-cadence-trends`/`get-cadence-trend-data`,
and `view-route-map`/`get-route-map-data` are all ported to intervals.icu.

App tool inputs follow the one scheme (docs/architecture.md, Input validation):
`id` for a single activity (`view-activity-chart`, `view-route-map`,
`view-activity-zones` and their feeds), `activityId1`/`activityId2` for
`view-compare-activities` and `get-compare-activities-data`, and `days` (7-728,
default 42) for `view-cadence-trends` and `get-cadence-trend-data`.
`view-training-load`, `view-fitness-trend` and their feeds take `days` and an
optional `newest`, the same field as the text tool. The old
`activity_id`, `activity_id_1`/`activity_id_2` and `weeks` are still accepted
through the alias layer.

| Tool | Description |
| ---- | ----------- |
| `view-activity-chart` | Interactive chart with HR, power, pace, altitude, cadence, grade, and running-dynamics overlays; interval bands (MCP App) |
| `get-activity-streams-raw` | Downsampled per-sample streams plus interval bands for the activity chart UI (app-only) |
| `view-cadence-trends` | Interactive cadence trends with timeline, scatter, zones, and overlay views (MCP App) |
| `get-cadence-trend-data` | Summary cadence/pace data for the cadence trends UI (app-only) |
| `view-route-map` | Interactive map of an activity's GPS track, fit to bounds with start/finish markers; optional distance-anchored waypoints (MCP App) |
| `get-route-map-data` | `[lat, lng]` coordinates from the activity's latlng stream plus index-aligned metric streams and WORK-interval end markers for the route map UI (app-only) |
| `view-training-load` | Weekly running-volume bars with a rolling trend line, volume-spike warning weeks, a weekly load line, and Fitness/Fatigue/Form tiles; `runOnly` picks the scope load and CTL/ATL/TSB cover, and a Whole body/Runs only toggle in the card switches it, caching each side; `newest` ends the chart on a past date, and a past partial week is labelled partial. Its text adds a `Scope:` line (whole-body with the activity types, or run-only, and where CTL/ATL came from) and a `Current (as of DATE): CTL x / ATL y / TSB +z` line when fitness is known (`End of window` and a `Past window:` line for a past window); its `Load:` total is the payload's `totals.load` (MCP App) |
| `get-training-load-data` | Per-week volume, trend value, warning flags, weekly load, and current CTL/ATL/TSB for the training-load UI; `runOnly` (default false) switches load and CTL/ATL/TSB between whole-body and run-only, while volume and spike warnings stay run-based (app-only) |
| `view-compare-activities` | Interactive overlay of two activities' streams on a shared distance/time axis with a delta summary (MCP App) |
| `get-compare-activities-data` | Aggregate comparison (summaries, activity2−activity1 differences, efficiency) for the compare-activities UI (app-only) |
| `view-activity-zones` | Time-in-zone bar chart for one activity's HR zones with an easy/moderate/hard split (power zones dropped for now; see docs/api-notes.md) (MCP App) |
| `get-activity-zones-data` | Per-zone time distributions (bucket bounds, seconds, percentages) for the activity-zones UI (app-only) |
| `view-fitness-trend` | CTL/ATL/TSB over time with shaded fatigue/freshness/ramp bands and a dashed taper plan or rest projection past today; a Whole body/Runs only toggle switches scope, caching each side; `newest` charts a past block with no projection (MCP App) |
| `get-fitness-trend-data` | Per-day CTL/ATL/TSB, the projection, the solved taper, and the dated warning bands for the fitness-trend UI; `runOnly` switches between whole-body (intervals.icu wellness) and run-only (computed) (app-only) |

A `view-*` result says the chart was rendered only when the request's client
capabilities advertise `io.modelcontextprotocol/ui` with
`text/html;profile=mcp-app` (`clientSupportsMcpApps`, `clientCapabilities.ts`).
Otherwise it has no "rendered above" line and ends with `This client cannot
display the interactive <kind>. For detail, call <twin>.` A call with no client
information is treated as a host that cannot render apps. Both footers come
from `viewFooter`; a test checks every tool the twin names is advertised. The
rest of the text never mentions on-screen UI to such a host: `view-route-map`
says "No GPS track is recorded for this activity." rather than calling the map
empty, and counts waypoints without the map legend.

| Tool | Footer kind | Text tool it names |
| ---- | ----------- | ------------------ |
| `view-activity-chart` | `activity chart` | `get-activity-streams` (`get-activity` when the activity has no streams) |
| `view-cadence-trends` | `cadence trends chart` | `list-activities, then get-running-summary` |
| `view-training-load` | `training load chart` | `get-training-load with the same arguments` |
| `view-fitness-trend` | `fitness trend chart` | `get-fitness-trend with the same arguments` |
| `view-activity-zones` | `zone distribution chart` | `get-activity-zones` |
| `view-route-map` | `route map` | `get-activity` |
| `view-compare-activities` | `activity comparison` | `compare-activities` |

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
| `weekly-review` | `weeks` (optional, 1-52, default 4) | Reviews recent training (load trend, key workouts across the whole window, cadence patterns), ending with focus points for next week |
| `annotate-last-run` | `id` (optional, defaults to the newest Run, TrailRun or VirtualRun; `activity_id` still accepted) | Analyses a run and appends a short coaching note to its activity description. Confirms before writing |
| `race-readiness` | `raceDate` (required, after today, at most 180 days ahead), `distance` (optional), `targetTsb` (optional, default 10) | Race-day form and the taper that lands on it, predicted time, last 7 days of recovery, recent load; ends with a ready / nearly / not-yet verdict |
| `run-debrief` | `id` (optional, defaults to the newest run) | The run summary, then the one analysis that fits the session (intervals, splits, hills or aerobic), plus that day's wellness |
| `injury-check` | none | Load spikes and warnings, the 4-week HRV and resting-HR trend, form flags and shoe mileage; ends with a risk read and what to change, not a diagnosis |

In Claude Desktop and Claude Code these appear in the prompt picker once the
server is connected. `annotate-last-run` uses a write tool (`update-activity`),
so a client needs to grant it before the prompt can write the note.

A bad argument (`weeks: 100`, a past `raceDate`, an unknown distance) is
rejected with Invalid Params (-32602) naming the fix, rather than rendering a
workflow the tools would then refuse. The server advertises `completions`:
`completion/complete` suggests race distances and `targetTsb` values for
`race-readiness` and review lengths for `weekly-review`. Activity ids get no
suggestions, because a completion is a bare value with no label and each
keystroke would cost an intervals.icu request.

## Tool permissions

Every tool declares MCP annotations so a host can tell reads from writes. The
read tools set `readOnlyHint: true` and `destructiveHint: false`, which is
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

**Zones and thresholds**

- "What are my heart rate zones? Is 150 bpm zone 2 for me?"
- "Is my LTHR out of date?"

**Stats**

- "What are my running stats for this year?"
- "How many strength sessions have I done this month?"
- "How far have I swum this year?"

**Training analysis**

- "Break down the intervals in activity 12345678 — did I fade across the reps?"
- "How much did the climbs cost me on Sunday's long run?"
- "Did I positive-split Sunday's long run, or was that just the hills?"
- "What was my fastest 5K inside Sunday's half marathon, and where did it start?"
- "Am I fresh enough to race this weekend? Check my CTL, ATL, and TSB"
- "My race is on 13 September — what should the next three weeks look like so I arrive at TSB +10?"
- "Did I decouple on that marathon-pace effort?"
- "Am I getting faster at my 1 km repeats?"
