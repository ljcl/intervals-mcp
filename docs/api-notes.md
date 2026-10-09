# intervals.icu API notes

Contract: `docs/intervals-openapi.json`, from `https://intervals.icu/api/v1/docs` (refresh with the curl in docs/development.md). Record anything the spec does not say here, with the date and how it was verified.

## Auth
- HTTP Basic. Username is the literal `API_KEY`, password is the personal key (`securitySchemes.APIKey`). A bearer scheme exists for OAuth apps; not used.
- Athlete path id `0` means the key's own athlete (`INTERVALS_ATHLETE_ID` default).
- Send a descriptive `User-Agent` (`intervals-mcp/<version> (+https://github.com/ljcl/intervals-mcp)`); some clients meet a Cloudflare challenge without one.

## Base URL and ids
- Base: `https://intervals.icu/api/v1`.
- Activity ids are strings such as `i12345678`. Pass through unchanged.
- `/activity/{id}` is global, not athlete-scoped. Resolve gear against the activity's own `athlete_id`.
- The singular `/event/` route 404s; events use `/athlete/{id}/events/{eventId}` (not used: RunFun owns the plan).

## Endpoints (verified against spec)
Paths below are relative to the base URL above (spec lists them as `/api/v1/...`; verified 2026-09-24 against `docs/intervals-openapi.json`, `jq -r '.paths|keys[]'`).

| Need | Method and path |
| --- | --- |
| Activities list | `GET /athlete/{id}/activities` |
| Activity | `GET /activity/{id}`, `PUT /activity/{id}`, `DELETE /activity/{id}` |
| Streams | `GET /activity/{id}/streams{ext}` (`ext` empty for JSON, `.csv` for CSV) |
| Intervals | `GET /activity/{id}/intervals`, `PUT /activity/{id}/intervals` |
| Best efforts | `GET /activity/{id}/best-efforts` |
| HR curve | `GET /athlete/{id}/hr-curves{ext}` (across activities), `GET /activity/{id}/hr-curve{ext}` (one activity) |
| Pace curve | `GET /athlete/{id}/pace-curves{ext}` (across activities), `GET /activity/{id}/pace-curve{ext}` (one activity) |
| File | `GET /activity/{id}/file` (original upload; spec summary says "Strava activities not supported") |
| Fit file | `GET /activity/{id}/fit-file` (intervals.icu-generated) |
| Athlete | `GET /athlete/{id}`, `PUT /athlete/{id}` |
| Sport settings | `GET /athlete/{athleteId}/sport-settings`, `POST`/`PUT` (create/update); per-id `GET`/`PUT`/`DELETE /athlete/{athleteId}/sport-settings/{id}` |
| Wellness | `GET /athlete/{id}/wellness{ext}` (date range; `.csv` for CSV), `POST`/`PUT /athlete/{id}/wellness` |
| Wellness/{date} | `GET /athlete/{id}/wellness/{date}`, `PUT /athlete/{id}/wellness/{date}` |
| Gear | `GET /athlete/{id}/gear{ext}` (list; `.csv` for CSV), `POST /athlete/{id}/gear` (create); per-item `PUT`/`DELETE /athlete/{id}/gear/{gearId}` |
| Interval search | `GET /athlete/{id}/activities/interval-search` |
| Activities by id | `GET /athlete/{athleteId}/activities/{ids}` (comma-separated) |

## Writes
- `PUT /activity/{id}` takes only the fields to change. To clear a numeric field send `-1`.

## Pagination
- List endpoints have no pagination. Page by date with `oldest` / `newest` (ISO local dates).

## Rate limits
- Draft (June 2026, go-live unconfirmed): 5,000 requests/day and 2,500 per rolling 15 minutes per key, about 10/s per IP.
- No `X-RateLimit-*` or `Retry-After` headers observed on 2026-09-24; the client throttles itself (see `intervalsApi` in fetchClient.ts).

## Verified (2026-09-24)

Captured with `scripts/capture-intervals-fixtures.ts` against a real account; sanitized fixtures
at `apps/server/src/__fixtures__/intervals/`.

- `GET /athlete/0/activities?oldest=&newest=` returns an array; no pagination; all sources `OAUTH_CLIENT`, `oauth_client_name: "HealthFit"`, `file_type: "fit"`, `device_name: "Watch7,5"`, `strava_id: null`.
- `GET /activity/{id}` has `average_cadence` in strides/min (83.2 means 166 spm), running-dynamics averages `average_stance_time` (ms), `average_vertical_oscillation` (mm), `average_vertical_ratio` (%), `average_step_length` (mm), `average_stride` (m); `average_leg_spring_stiffness`, `average_impact_loading_rate`, `average_stance_time_balance` are null for Apple Watch. `icu_intervals` is empty unless `?intervals=true`. `gear` is `null` when no gear is assigned, otherwise `{ id, name: null, distance: null, primary: null }` (name/distance are not populated on the activity; resolve them via `GET /athlete/{id}/gear`). `stream_types` lists available streams.
- `GET /activity/{id}/intervals` returns `{ id, analyzed, icu_intervals[], icu_groups[] }`; intervals carry `type` (`WORK`/`RECOVERY`), `distance`, `moving_time`, `average_heartrate`, `average_cadence`, `average_stance_time`, `average_vertical_oscillation`, `average_step_length`.
- `GET /activity/{id}/streams.json?types=a,b` returns `[{ type, data, data2, valueTypeIsArray, ... }]`. `latlng` puts latitude in `data` and longitude in `data2`. Apple Watch streams: `time, watts, cadence, heartrate, distance, altitude, latlng, velocity_smooth, stance_time, vertical_oscillation, vertical_ratio, step_length, torque, fixed_altitude`.
- `GET /athlete/0/wellness?oldest=&newest=` returns an array keyed by `id` (date). Apple Watch HRV arrives in `hrvSDNN`; `hrv` (rMSSD) is null. `restingHR`, `sleepSecs`, `weight`, `ctl`, `atl`, `rampRate` present.
- Wellness HRV fields (2026-09-26, #48): `hrv` carries rMSSD and `hrvSDNN` carries SDNN, both in ms. The spec types both as plain floats and describes neither. Which field is set depends on the source device. Apple Watch sets only `hrvSDNN` (above). #48 reports that Garmin, Oura and Whoop set `hrv` and leave `hrvSDNN` null. This account has no such device, so that part is not verified here. `get-wellness` reads both fields and assumes neither.
- Stride and step length (2026-09-26, #76): `average_stride` (m) is distance per step, not per two-step stride. It equals distance divided by moving time, divided by the step rate (`average_cadence` times 2, divided by 60). This holds to four decimals on the three fixture runs and on every fixture interval. For example, run `i189807578` covers 8,030.29 m in 2,372 s at 83.155 strides/min: 3.3855 m/s over 2.7718 steps/s gives 1.2214 m, and `average_stride` is 1.2213699. So intervals.icu computes it from speed and cadence. `average_step_length` (mm) is the device's own step length. On whole runs the two agree within about 1% (1,226 mm and 1.221 m, 1,108 mm and 1.097 m, 1,209 mm and 1.204 m on the three fixture runs). On an interval they can differ: a slow WORK interval in `activity-multilap-intervals.json` (803 m in 320 s) has `average_stride` 0.900 m and `average_step_length` 1,191 mm. The text of `get-activity` and `get-running-dynamics` prints step length only. `stride_m` stays in structuredContent.
- `GET /athlete/0/sport-settings/Run`: `lthr`, `max_hr` and `hr_zones` (ascending bpm upper bounds, the last equal to `max_hr`); `threshold_pace` and `pace_zones` null at this capture (both set since; see "Sport settings and HR curves" below).
- Athlete HR on the activity (2026-09-27, #47, from the committed fixtures): `GET /activity/{id}` carries `athlete_max_hr` and `lthr` (the athlete's settings, OpenAPI `Activity`) next to `icu_hr_zones`. On `activity.json`, `activity-hilly.json`, `activity-multilap.json` and every row of `activities.json`: `athlete_max_hr` 190 and `lthr` 172. `icu_hr_zones` is `[142, 154, 163, 171, 190]` on the runs and a 7-zone set ending at 190 on some other types, so the last zone bound equals `athlete_max_hr` either way. `max_heartrate` is the run's own peak (182 to 186 on those runs). `get-interval-analysis` reads `athlete_max_hr`, then the last zone bound.
- Sliver intervals (2026-09-27, #47): `activity-multilap-intervals.json` ends with a WORK interval of 26 m in 12 s and a RECOVERY interval of 4 s with `distance` and `average_speed` null, and has a 21 m / 6 s RECOVERY interval mid-run. Apple Watch activities often end this way. `get-interval-analysis` ignores intervals under 50 m or 15 s.
- `GET /athlete/0/gear` returns Gear objects `{ id (numeric string, e.g. "71459"), name, type ("Shoes"), distance (metres, includes the starting distance entered in the UI), activities (count), retired (null when active), reminders ([]) }`.
- `PUT /activity/{id}` with `{"gear":{"id":"<gearId>"}}` returns 200 and assigns the gear: the activity then reads `gear: { id, name: null, distance: null, primary: null }` (name is not populated on the activity; resolve it via the gear list), and the gear's `distance` increases by the activity distance and `activities` by 1 (54000 to 62030.29 m on the test).
- `{"gear": null}` and `{"gear": {"id": null}}` both return 200 but are ignored: gear cannot be cleared this way. `update-activity` should support switching gear, not clearing it.
- Missing activity returns HTTP 404 with a small JSON body.
- Responses carry no `X-RateLimit-*` or `Retry-After` headers (only Cloudflare headers).
- An activity's (and each interval's) `gap` field is grade-adjusted speed in m/s, the same unit as
  `average_speed`: not documented by the spec, but verified by checking `gap` sits in the
  same range as `average_speed` and that each interval's `gap` tracks its `average_speed` up or
  down with the interval's grade direction, the signature of a grade-adjusted speed rather than a
  pace-per-metre value. See `gapPace` in `apps/server/src/utils/running.ts` for the conversion
  to a pace string with `metersPerSecToPace`.
- Strava stub spike: the account has no Strava-sourced activities to test against; every activity
  in `GET /athlete/0/activities` is `source: "OAUTH_CLIENT"` (HealthFit) with `strava_id: null`, not
  a single `source: "STRAVA"` row. `list-activities`' and `get-activity`'s `is_strava_stub` flag
  (`a.source === "STRAVA"`) is therefore an assumption about what a Strava-synced stub's `source`
  value looks like, not something observed against a live one. Re-verify against a real
  Strava-sourced activity (or ask in the intervals.icu support channel) before relying on
  `is_strava_stub` for anything beyond the advisory note it drives today.

## Phase 2 probes (2026-09-24 research, verified before the analysis tools were built)

| Endpoint | Status | Shape and units |
| --- | --- | --- |
| `GET /athlete/0/pace-curves.json?type=Run&curves=all,90d,...` | 200 | Works with athlete id `0`; `{list[{id,label,distance[],values[] s,activity_id[],paceModels[{type:"CS",criticalSpeed m/s,dPrime m,r2}]}], activities{}}`. Curve ids used: `1y` (get-best-efforts default), `all`, `90d` (get-race-prediction) |
| `GET /athlete/0/activity-pace-curves.json?...` | 403 | Athlete id `0` is denied (2026-09-25). On 2026-10-08 the bare numeric id was denied too, and the `i`-prefixed id from `GET /athlete/0` worked. Not used since #82: `pace-curves.json` with `subMaxEfforts` gives the same ranks |
| `GET /athlete/{numericId}/athlete-summary.json?start&end` | 200 | Weekly rows (Monday-aligned, newest first), totals plus `byCategory[]`; probed but not used: get-athlete-stats instead fetches `list-activities`' underlying `/activities` and aggregates run totals (`aggregateRunTotals`) and per-sport totals (`aggregateSportTotals`) locally, so its bucket boundaries (Monday-aligned week, local calendar month/year) match the rest of the server rather than this endpoint's own |
| `GET /activity/{id}/interval-stats?start_index&end_index` | 200 | Interval-shaped stats for any stream index range, including `gap` (m/s) |
| `GET /activity/{id}/time-at-hr` | 200 | `{max_bpm, min_bpm, secs[], cumulative_secs[]}` |
| `GET /activity/{id}/streams.json` | 200 | `moving` is never returned (silently omitted, not an error); `grade_smooth` (%) and `fixed_altitude` (m) are present; `gap` is not a valid stream type (422 "Invalid stream type") |

- `pace-curves.json` gives each grid distance to the run that is fastest there, so one long run
  owns a long stretch of the grid. In the 2026-09-25 probe (`pace-curves.json` fixture), the 91
  points of 1,500 m and up on each of `all` and `90d` came from 6 runs, and one 42.8 km run held
  35 of them on `all` and 43 on `90d`. The points are sub-segments, not independent efforts,
  which is why `get-race-prediction` keeps one per run. The `activities{}` map carries `name`,
  `distance`, `moving_time`, `start_date_local`, `training_load`, `icu_weight` and a `race`
  boolean per activity. Every activity on this account has `race: false`, so a `true` value has
  not been observed yet.
- `decoupling` and `icu_efficiency_factor` are null on every activity since 2024-01-01 for this
  account, so the analysis tools' unit convention for both (`decoupling_pct` as a percent;
  `efficiency_factor` as pace/power per heartbeat) is an assumption carried over from the
  intervals.icu UI and the OpenAPI field names, not something observed on a populated value.
  Re-verify against an activity that actually carries these fields before trusting the unit beyond
  the advisory framing the tools already give it. Which basis intervals.icu uses for them (power,
  raw pace, or grade-adjusted pace) was never observed either, so `get-aerobic-analysis` reports
  them with `basis: null` and no efficiency unit, and keeps them apart from any value it computes
  (#74).
- Power zones are dropped from `mapIntervalsZones` (`activityZones.ts`) and the
  `get-activity-zones`/activity-zones-app outputs for now, rather than shipped unverified.
  `icu_zone_times`'s `{id, secs}` shape (per `IntervalsZoneTimeSchema`) has not been exercised
  against a real response with power zone times recorded on this account, and `icu_power_zones`
  looks like it may be percent-of-FTP bounds rather than watts, with an extra Sweet Spot (SS)
  time entry that would misalign a positional pairing against `icu_zone_times`. Before
  re-adding: confirm on a populated activity whether `icu_power_zones` values are watts or
  percent of FTP, whether `icu_zone_times` has one entry per `icu_power_zones` bound or one
  extra (SS), and whether pairing by `id` (rather than by array index, as `activityZones.ts`
  did before this was dropped) is needed to line entries up correctly.
- `fixed_altitude` (m) is present on Apple Watch runs, but what it holds (a corrected track, or
  a terrain-model lookup) is not known: `docs/intervals-openapi.json` does not mention it, and
  no probe compared it with `altitude` (checked 2026-09-27, no live access). Hill and split
  analysis use `grade_smooth` and `altitude` only. Compare the two streams on a run with a
  noisy barometric track before using `fixed_altitude` for grade.
- A stream that is entirely null (`allNull: true`) reaches the analysis modules as an array of
  nulls. Hill and split analysis treat an all-null `altitude` as no altitude, not as flat
  ground (#45).
- `average_gradient` (interval field) is a fraction, not a percent: confirmed by checking
  elevation gain against `average_gradient * distance` (see `intervalLaps.ts`).

## Phase 3 probes (2026-09-25 research, load and fitness fields)

Fetched wellness and activities 2026-01-01..2026-09-24 (267 wellness rows, 244 activities),
sport-settings, fitness-model-events, athlete-summary, and one activity, all against athlete 0.

- Every wellness row has `ctl`, `atl`, `rampRate`, `ctlLoad`, `atlLoad` (floats). `ctlLoad`/`atlLoad`
  are that day's load feeding each curve and differ on about 1 in 5 days (e.g. `ctlLoad` 0,
  `atlLoad` 21 on a day with a WeightTraining-only session).
- `sportInfo` is present on every wellness row but is not a per-sport CTL/ATL: shape
  `[{type, eftp, wPrime, pMax}]` (only `type: "Ride"` observed, all values null on this account).
  intervals.icu has no run-only CTL/ATL anywhere in wellness.
- `GET /athlete/0/wellness?fields=id,ctl,atl,ctlLoad,atlLoad` returns only the requested keys: use
  `fields=` to keep a wellness read small.
- Activity load fields by type (2026-08-01..2026-09-24): Run's `icu_training_load` equals
  `pace_load`, not `hr_load`; every other observed type (WeightTraining, Pilates, Swim, Ride,
  Workout) has `icu_training_load` equal `hr_load` (HRSS). Sport settings' `load_order` confirms
  this: Run is `POWER_PACE_HR`, everything else is `POWER_HR_PACE`. `power_load` and
  `strain_score` are present as keys but null on every activity on this account (no power meter).
  `icu_rpe` is populated on most activities; `session_rpe` appears to be `icu_rpe` scaled by
  duration (matches three fixture activities; not otherwise confirmed).
- Reproducing the fitness model: seeding from wellness `ctl`/`atl` the day before a window and
  feeding wellness `ctlLoad`/`atlLoad` into `x += (load - x) * (1 - exp(-1/N))` with `N = 42` (CTL)
  and `N = 7` (ATL) reproduces intervals.icu's own `ctl`/`atl` exactly (max error 0.000 over
  2026-06-01..2026-09-24). Feeding the daily sum of activity `icu_training_load` instead
  reproduces `atl` exactly (`atlLoad` is exactly that sum) but not `ctl` (max error ~3.2): solving
  per day shows WeightTraining and Workout activities are excluded from `ctlLoad` on this account
  (they still count into `atlLoad`) while Run, Pilates, Swim, Ride, Walk, and OpenWaterSwim are
  included. No sport-settings field explains the exclusion; it is reported here as an observed
  fact for this account, not a documented rule.
- `GET /athlete/{id}/fitness-model-events` (custom `FITNESS_DAYS`/`SET_FITNESS`/`SET_EFTP` events
  that would change the constants above) returns `[]` on this account.

## Per-sport totals (2026-10-08, #83, live read-only)

Two reads against athlete 0 for the year to date: `GET /athlete/0/activities?oldest=&newest=`
(253 rows) and `GET /athlete/0/wellness?oldest=&newest=&fields=id,atlLoad,ctlLoad` (281 rows).

- `type` was set on every row. It is the intervals.icu type name. The spec lists 60 values
  (`Ride` to `Other`) and has no separate sport category. 8 types appeared: Run, Swim,
  OpenWaterSwim, Ride, Walk, WeightTraining, Pilates and Workout. `sub_type` was null on every row.
- `distance` (m) and `icu_distance` are `null`, never 0, on every WeightTraining, Pilates and
  Workout row. Every row of the other types had a distance above 0.
- `moving_time` (s, a whole number) was set and above 0 on every row. On WeightTraining, Pilates
  and Workout rows it equals `elapsed_time` on all but 4 of 105 rows. On the distance types it is
  always lower than `elapsed_time`.
- `icu_training_load` was set, above 0 and a whole number on every row of every type. The spec
  types it `int32`. Not verified: when it is null. get-athlete-stats adds 0 for a null load, as
  its run totals already do.
- `total_elevation_gain` is null on every WeightTraining, Pilates, Workout, Swim and
  OpenWaterSwim row.
- The sum of `icu_training_load` over the activities of a date range equals the sum of wellness
  `atlLoad` over the same dates. It was exact on each of get-athlete-stats' four periods and on
  each of the 281 days. So this sum is the whole-body load, and the per-type loads add up to it.
  The `ctlLoad` sum is lower, because this account's WeightTraining and Workout load is left out
  of `ctlLoad` (see "Phase 3 probes").
- get-athlete-stats builds its per-sport totals (`aggregateSportTotals`) from the same
  `/activities` rows as its run totals. It does not read `athlete-summary.json`'s `byCategory[]`
  (see the Phase 2 table), so both sets use the same periods as the rest of the server.

## Phase 4 probes (2026-09-25 research, streams and map, live read-only, run i189807578)

`GET /activity/{id}/streams.json?types=latlng,velocity_smooth,cadence,heartrate,altitude,distance,time,stance_time,vertical_oscillation,vertical_ratio,step_length,grade_smooth`
(all 12 requested types), 200, about 201 KB:

- Response order is not request order (observed: time, cadence, heartrate,
  distance, altitude, latlng, velocity_smooth, grade_smooth, then the
  dynamics streams). Every item carries `allNull, anomalies, custom, data,
  data2, name, type, valueType, valueTypeIsArray`; `valueTypeIsArray` is
  `false` for all 12, including `latlng`.
- All 12 arrays are aligned at length 2,374 on this run (`latlng`'s `data`
  and `data2` are both 2,374 too).
- `time`: 0..2373, 0 nulls, no gaps over 1s on this run (continuous 1 Hz;
  other runs have auto-pause gaps, see "Recording gaps" below).
- Leading/trailing-only nulls: `cadence` 0, `heartrate` 0; `distance` 2,
  `altitude` 2, `grade_smooth` 2, `latlng` 2 (both `data` and `data2`), all
  at indices 0-1; `velocity_smooth` 7 (3 leading, 4 trailing).
- Dynamics nulls (leading / trailing / interior): `stance_time` 59
  (18/12/29), `vertical_oscillation` 59 (13/17/29), `vertical_ratio` 77
  (13/17/47), `step_length` 64 (11/14/39). The interior gaps mean a dynamics
  overlay must handle mid-run nulls, not just edges, matching the gap policy
  `activityChartData.ts` and `routeMapData.ts` already apply (null metric
  samples render as a gap; gap-free axes are filled before downsampling).
- `grade_smooth` is returned even though this activity's own `stream_types`
  field does not list it: it is computed on request. `stream_types` also
  lists `watts`, `torque`, `fixed_altitude` (not requested here).
- Byte sizes (JSON): `latlng` 49 KB, `grade_smooth` 25 KB, `distance` 19 KB,
  each dynamics stream 12-17 KB; a 40-minute run is about 200 KB raw, which
  is why app payloads downsample to about 1,000 points.

`GET /activity/{id}/map`, 200, about 53 KB. Response shape (OpenAPI
`MapData`): `{bounds, latlngs, route, weather}`. On this run: `bounds` has 2
pairs; `latlngs` has 2,374 entries, the same resolution as the `latlng`
stream, with 2 null entries and all others `[lat, lng]` pairs; `route` and
`weather` are both null. It gives nothing the `latlng` stream does not (same
resolution, same nulls, no encoded polyline), so `routeMapData.ts` uses the
stream and does not call `/map`. There is no polyline endpoint anywhere in
`docs/intervals-openapi.json` (checked by path search for
map/polyline/gps/latlng): the only geometry endpoints are `/activity/{id}/map`
above plus athlete `/routes`, `/routes/{route_id}`, `/similarity`. A
stream-less (manual) activity has no GPS at all; there is no polyline
fallback to reach for.

`GET /activity/{id}?intervals=true`, 200: `icu_intervals` has 2 entries on
this run (1 WORK, index 0-2075; 1 RECOVERY, index 2075-2374), both carrying
`start_index`/`end_index`/`start_time`/`end_time`, `label` null on both,
`icu_lap_count` 1. There is no polyline/map key on the activity payload
itself.

## Heart-rate dropouts (2026-09-26, live read-only check)

intervals.icu returns 0, not `null`, for a heart-rate sample where the
sensor lost contact.

- Live check on 2026-09-26: a 42 km run had a heart-rate dropout in the
  first 5 km. Before the fix (#46), `get-activity-streams` with
  `maxPoints: 2000` returned 141 buckets at 0 bpm and 12 buckets between 25
  and 119 bpm. The mixed buckets averaged dropout zeros with real samples.
- The hilly capture (`streams-hilly.json`) shows the same pattern: 453 of its
  600 `heartrate` samples are 0, in five stretches, while `cadence`, `watts`
  and `velocity_smooth` carry on as normal. `streams-hr-dropout.json` is its
  first 104 samples: real heart rate, a dropout at samples 26-71, then real
  heart rate again.
- `loadIntervalsStreams` (`intervalsStreams.ts`) maps every `heartrate`
  sample of 0 or below to `null`, once, for every caller. `watts` and
  `cadence` keep their zeros: 0 W while coasting and 0 cadence while stopped
  are real values.

## Recording gaps and the derived `moving` stream (2026-09-27, #73, fixtures only)

intervals.icu never returns a `moving` stream, so `loadIntervalsStreams`
derives it (docs/architecture.md, "Streams").

- Verified: the `time` stream keeps auto-pause gaps (38 to 76 s on this
  account, 2026-09-24). In `streams-multilap.json` the 74 s gap (t=164 to
  t=238) has `distance` flat at 525.92 m and `velocity_smooth` `null` on
  both sides. The same fixture has two short gaps: 3 s at t=430 (3.06 m
  covered) and 4 s at t=529 (0 m).
- `recording_stops` on that activity is `[164, 431, 530, 2215, 3023, 3283]`.
  The first three match those gaps to within 1 s. So the values are elapsed
  seconds, not sample indices (the gap at t=430 is at index 357). The spec
  only types the field as an integer array. The field gives where a stop
  starts, but not how long it is; the `time` stream shows every gap, so
  `moving` does not read `recording_stops`.
- Not verified: whether intervals.icu also keeps smart-recording gaps in the
  `time` stream (Garmin "smart recording" writes a sample every 1 to 8 s or
  so). This account has only Apple Watch runs at 1 Hz, and no live probe
  was made. The `moving` rule assumes that it does: a gap over 5 s is a stop
  only when the distance across it gives a speed below 0.5 m/s. To confirm,
  probe one smart-recording run: `GET /activity/{id}/streams.json?types=time,distance`,
  read-only. Record the gap sizes and the distance across them here.
- Also not verified: what `distance` does across a pause when the runner
  walks on. If the device holds distance while paused, the gap reads as a
  stop. If intervals.icu fills the gap with the GPS distance, a walk at over
  0.5 m/s reads as moving, and its time and distance both count.

## update-activity live write check (2026-09-25, user-approved, one run)

Controller-run, one write to one activity, approved by the user before running: `update-activity`
changed the activity's name, appended to its description, and set RPE (`icu_rpe`) in a single
call. The re-read confirmed all three changed values. Gear was left untouched (not part of this
write) and, as documented above, cannot be cleared via `PUT /activity/{id}` regardless. Everything
was restored to its original value afterward. Also confirmed: setting `description: ""` with
`descriptionMode: "replace"` clears the description.

`feel` was not exercised by this write check. Its scale was verified separately (2026-09-26):
setting Feel to "Strong" in the intervals.icu web UI reads back as `feel: 1`, so 1 is the
strongest feeling and 5 the weakest, as `update-activity`'s tool description says.

## Activity search probe (2026-10-05, live read-only)

- Athlete id `0` works on `GET /athlete/0/activities/search-full?q=&limit=` and `/activities/search`.
- `search-full` returns full Activity rows (185 keys) so the list mapper applies.
- Name match is case-insensitive and not bounded by date ("RUN" matched 78 activities back to 2024-09-26).
- Without `limit` it returns 30.
- `search-full` returns the most recent matches first: a `limit=5` probe returned the 5 newest runs (2026-10-01 back to 2026-09-10), and `limit=200` returned all 78 newest first.
- `/activities/search` returns light rows (`id,name,start_date_local,type,race,distance,moving_time,tags,description`).
- `race` (boolean) and `tags` (null or string array) appear on both `search-full` rows and `GET /athlete/0/activities` rows.
- `GET /athlete/0/activity-tags` returned `[]` and `q=#race` returned `[]` on an account with no tags, so tag search is unverified live (no tags on the probe account); the client test checks `#` is sent encoded.

## Best efforts and pace curves (2026-10-08, live read-only, #82)

Three runs (6.1, 21.2 and 31.0 km), all with auto-pause stops, and athlete
curves for a 90-day window (37 runs) and a 2-month range.

- `GET /activity/{id}/pace-curve.json` returns one `PaceCurve`: `distance[]`
  (m, the same fixed grid as the athlete curves, up to the largest grid
  point the run covers), `values[]` (whole seconds), `start_index[]` and
  `end_index[]` (sample indices into the activity's streams), and
  `type: "PACE"`. `activity_id`, `submax_values` and the dates are null.
- The rule behind every pace-curve value: for each start sample i, take the
  first sample j where `distance[j] - distance[i]` reaches the target. The
  time is `(time[j] - time[i]) * target / (distance[j] - distance[i])`,
  rounded to the nearest second, and the curve keeps the smallest. This rule
  gave every value on all three runs (313 of 313 points) and the same start
  and end index on 312 of them. `Math.floor` in place of rounding matched
  only about half. `bestEffortWindows` (`activityBestEfforts.ts`) is this
  rule; `activity-pace-curve.json` and `streams-time-distance.json` (one run)
  pin it in `activityBestEfforts.test.ts`.
- So a pace-curve time is elapsed time across the stretch. The `time` stream
  keeps auto-pause gaps, so a stop inside the stretch counts. On a 21.2 km
  run with 1,101 s of stops, the curve's half marathon spans the whole run
  and includes every stop. Short distances usually avoid stops, because a
  stop makes the stretch slower. Before #82, get-best-efforts called the
  curve "moving-time style"; that was wrong.
- The athlete curves are built from the activity curves: `pace-curves.json`
  for a one-day custom range with one run gave the same `distance[]` and
  `values[]` as that run's own curve. The athlete curves have no
  `start_index`/`end_index`.
- `subMaxEfforts=N` on `GET /athlete/0/pace-curves.json` adds
  `submax_values` and `submax_activity_id` to each curve: N rows, row r
  holding the (r+2)th best time and its activity at each grid index. A row
  is truncated, not null-padded, where fewer activities reach the distance.
  With N=2 and N=4, no activity appeared twice at a grid index, times never
  decreased with rank, and every activity was in the `activities` map. Ranks
  1 to 3 matched a local ranking of `activity-pace-curves.json` over the same
  dates at all six standard distances. `get-best-efforts` reads its `topN`
  ranks this way, in one request.
- `includeRanks=true` adds nothing to `type=Run` pace curves.
- `GET /activity/{id}/best-efforts?stream=&distance=|duration=&count=`
  accepts `stream=velocity_smooth`, `time` and `distance`; `pace` and `gap`
  return 422 "Invalid stream type". It returns
  `{efforts[{start_index, end_index, average, duration, distance}]}`: the
  `count` best windows that do not overlap, by highest `average`. With
  `distance=`, `duration` is null and `distance` (m) is
  `distance[end_index] - distance[start_index - 1]`. With `duration=`,
  `distance` is null and a window spans `duration` samples. `average` is the
  mean of the stream over samples `start_index` to `end_index - 1`, a null
  counting as 0. With `time` or `distance` the best window is only the one
  with the largest values. The `velocity_smooth` mean leaves out stopped time
  and read about 1% faster than distance over time, so its best 5 km was not
  the pace curve's best 5 km. Not used.
- `GET /athlete/0/activities/{ids}` (comma-separated) works with athlete id
  `0` and returns full Activity rows in request order. A missing id is left
  out with no error. A bare-digit id (no `i` prefix) returned no row.
  `fields=` is ignored here. Not used by get-best-efforts.
- No activity on this account has `ignore_parts` set (0 of 610 over two
  years; the spec's `Ignore` is `{start_index, end_index, power, pace, hr}`),
  so how a part ignored for pace changes a curve is not verified.
  get-best-efforts leaves out the `pace: true` parts, both ends included, and
  only when the stream loader dropped no sample (a sample with no time
  shifts the indices). No activity has `ignore_pace` set either, so whether
  intervals.icu leaves such a run out of the athlete pace curves is not
  verified; get-best-efforts says only that it may.
## Sport settings and HR curves (2026-10-08, #79, live read-only)

Sport settings:

- `GET /athlete/0/sport-settings` returns an array with one entry per settings
  group (4 on this account: a ride group, `Run`/`VirtualRun`/`TrailRun`,
  `Swim`/`OpenWaterSwim`, and `Other`), about 10 KB. Each entry has the same
  fields as `GET /athlete/0/sport-settings/Run`; the Run entry is identical to
  that response.
- `GET /athlete/0/sport-settings/{type}` resolves a type to its group:
  `TrailRun` returns the Run group. A valid type with no group of its own
  (`Rowing`) returns the group with `other: true` (`types: ["Other"]`). The
  type is case-sensitive: `run` and an unknown type return 404
  `{"status":404,"error":"Not found"}`.
- `hr_zones` are ascending bpm upper bounds, and the last one equals `max_hr`
  on every group here. `hr_zone_names` has one name per zone.
- Upper bounds are inclusive. Counting each 1 Hz `heartrate` sample of a run
  in the first zone whose upper bound is at or above it gives the run's
  `icu_hr_zone_times` exactly. A strict "below the bound" count is off by up
  to 59 s per zone. Zone times count every sample, moving or not.
- `threshold_pace` is a speed in m/s, not a pace, also on the Swim group
  with `pace_units: "SECS_100M"`: for example, 0.8 m/s is 100 / 0.8 = 125 s,
  so 2:05 per 100 m.
  `pace_units` is a display setting only (`MINS_KM`, `SECS_100M`, ...).
- `pace_zones` are percentages of threshold speed, ascending, with 999 as the
  open top. The Run group has the intervals.icu default `[77.5, 87.7, 94.3,
  100, 103.4, 111.5, 999]`, named Zone 1 to Zone 5c. Checked on two runs: a
  run at 89.5% of threshold speed has most of its `pace_zone_times` in zone 3
  (87.7-94.3%), and a run at 96.4% has most in zone 4. Read as percentages of
  pace (time per km), both runs would be in the top zones. The Swim group has
  no pace zones on this account.
- `power_zones` on the ride group look like percentages of FTP
  (`[55, 75, 90, 105, 120, 150, 999]`), but no activity on this account has
  power-meter data to check them. `get-athlete-zones` reports `ftp` only.

HR curves:

- `GET /athlete/0/hr-curves.json?type=Run&curves=90d,1y` returns 200 with
  athlete id `0`. The spec marks `f1`, `f2` and `f3` as required; every call
  left them out and got 200.
- Shape: `{ list[{ id, label, start_date_local, end_date_local, days,
  moving_time, training_load, weight, secs[], values[], activity_id[] }],
  activities{} }`. `secs` is a duration in seconds, `values` the best average
  heart rate in bpm over that duration, and `activity_id` the activity that
  set it; the three are index-aligned. The `activities` map has the same
  fields as the pace-curves map and no `type`.
- The `secs` grid is fixed: every second to 60 s, then steps of 5 s to 120 s,
  10 s to 300 s, 30 s to 600 s, 60 s to 3,600 s, and 300 s after that. It
  stops at the longest activity in the window. So 60, 1,200, 1,800 and
  3,600 s are exact grid points when the window has an activity that long.
- `start_date_local` is the first day of the window; `end_date_local` is local
  midnight after today. `90d` covers 90 days including today.
- `type` picks the settings group: `type=TrailRun` returns the same curve as
  `type=Run`, and `type=Swim` a different one. `type=Rowing` (an Other-group
  type) and a call with no `type` also return the Run curve, so a curve for
  an Other-group type cannot be trusted. An unknown type returns 422.
- A window with no activities returns `{"list":[],"activities":{}}`: the
  curve id is missing from `list`.
- Run curves never rise with duration. Swim and ride curves rise by a few bpm
  in places, and a ride curve falls below 60 bpm at its longest durations,
  which looks like heart-rate dropouts (sent as 0) averaged in. A dropout can
  lower a best, not raise it.
- intervals.icu's own LTHR rule (from its `LTHR_UP` achievements, the
  `icu_achievements` entries on an activity): `point.secs` is 1,200 or 3,600.
  For a 20-minute point the new LTHR (`value`) is 98% of the point's heart
  rate, rounded, and `message` reads "98% of 20m at N bpm" (12 of 12 such
  achievements). For a 1-hour point `value` equals the point's heart rate,
  and `message` reads "1h at N bpm" (1 of 1). `get-athlete-zones` uses this
  rule on the 90-day curve (`lthrEstimate` in `athleteZones.ts`). Not
  verified: whether an `LTHR_UP` also changes the settings by itself.
## Interval search and bulk activity reads (2026-10-08, #84, live read-only)

29 read-only GETs against one account. Its runs are Apple Watch runs with device laps.

`GET /athlete/{id}/activities/interval-search?minSecs&maxSecs&minIntensity&maxIntensity&minReps&maxReps&type&limit`:

- Athlete id `0` works.
- `minSecs`, `maxSecs`, `minIntensity` and `maxIntensity` are required. A missing one returns 422 with a JSON body `{status, error}` that names the parameter.
- `limit` must be 100 or less. `limit=400` returns 422 "limit must be <= 100".
- It returns full Activity rows (185 keys, the same as `search-full`), newest first, with no `icu_intervals`.
- It searches all history, not a date window: results went back 16 months.
- It searches every sport. A wide band returned Run, Ride, Swim, OpenWaterSwim, Pilates, WeightTraining and Workout rows. Filter the sport on the client.
- The activity whose reps define the band is in the results.
- It matches RECOVERY intervals too. A band that fits only the 90 s jog recoveries of a 5 x 1 km session returned that session.
- `type` is a workout target (`AUTO`, `POWER`, `HR`, `PACE`), not the interval label and not the sport. Another value returns 422. On this account `type=HR` returned the same rows as no `type`. `AUTO`, `PACE` and `POWER` returned `[]`, also with intensity 0-300. `get-interval-analysis` sends no `type`.
- The match rule cannot be reproduced from an activity's current `icu_intervals`. With `minReps=5&maxReps=5`, 1 of the 4 returned runs had only 1 interval in the band, and 2 runs with 5 such intervals were not returned. Treat the result as candidates, and check each candidate from its own intervals.

Interval `intensity`:

- An interval's `intensity` is a whole percent of the sport's threshold: heart rate or pace, per the athlete's settings.
- On this account's runs it is `floor(average_heartrate * 100 / lthr)`, with the activity's own `lthr`, for all 341 intervals with heart rate across 30 runs. So it is heart rate as a percent of LTHR, although the Run sport settings also have a threshold pace.
- On this account's swims it is pace: `floor(average_speed * 100 / threshold_pace)` on all 6 WORK intervals of a pool swim and all 23 of an open-water swim (from the saved #86 probes, no new request). The pool swim's RECOVERY intervals have a null `intensity`.
- The activity's `icu_intensity` is a different number. For runs it is within 1 point of `gap` as a percent of the activity's `threshold_pace` (100 of 108 runs in 2026). Do not compare it with an interval's `intensity`.
- The Run sport settings have `interval_display: "POWER_HR_PACE"` and `load_order: "POWER_PACE_HR"`, and there is no power data. So interval intensity probably uses the first metric with data in the display order, and activity intensity the first in the load order. This is an inference from one account.
- `get-interval-analysis` builds its search band from the intervals' own `intensity` values, so the band does not depend on which metric they use.
- The three #84 fixtures (`activity-repeats`, `activities-similar`, `interval-search`) are trimmed by hand from live reads: fields kept, intensity recomputed against the synthetic LTHR, names `<Type> N`.
- An interval's `zone` places it in the athlete's real zones. No tool reads it. The fixture capture nulls it, and it rewrites a run interval's `intensity` against the synthetic LTHR (any other sport's to null), because both give away the real thresholds.

`GET /athlete/{athleteId}/activities/{ids}`:

- Athlete id `0` works. `ids` is a comma-separated list of `i`-prefixed ids. A bare numeric id is dropped.
- A repeated id and an unknown id are dropped with no error: 21 ids with one repeat and one unknown id returned 19 rows.
- Rows do not come back in request order. On 4 reads they came back oldest first by `start_date_local`. Key the result by `id`.
- `?intervals=true` adds `icu_intervals` and `icu_groups` to every row, the same as `GET /activity/{id}?intervals=true`. Without it, the rows have no `icu_intervals` key at all (absent, not null), the same as list and search rows.
- `fields=` is ignored: full rows come back.
- Size: 19 runs with intervals were 430 KB to 709 KB, read in about 1 s.
