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
- The singular `/event/` route 404s; events use `/events/{id}` (not used: RunFun owns the plan).

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
- `GET /athlete/0/sport-settings/Run`: `lthr`, `max_hr` and `hr_zones` (ascending bpm upper bounds, the last equal to `max_hr`); `threshold_pace` and `pace_zones` null.
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
| `GET /athlete/0/activity-pace-curves.json?...` | 403 | Athlete id `0` is denied on this endpoint specifically (unlike `pace-curves.json` above); needs the bare numeric athlete id |
| `GET /athlete/{numericId}/athlete-summary.json?start&end` | 200 | Weekly rows (Monday-aligned, newest first), totals plus `byCategory[]`; probed but not used: get-athlete-stats instead fetches `list-activities`' underlying `/activities` and aggregates run totals locally (`aggregateRunTotals`), so its bucket boundaries (Monday-aligned week, local calendar month/year) match the rest of the server rather than this endpoint's own |
| `GET /activity/{id}/interval-stats?start_index&end_index` | 200 | Interval-shaped stats for any stream index range, including `gap` (m/s) |
| `GET /activity/{id}/time-at-hr` | 200 | `{max_bpm, min_bpm, secs[], cumulative_secs[]}` |
| `GET /activity/{id}/streams.json` | 200 | `moving` is never returned (silently omitted, not an error); `grade_smooth` (%) and `fixed_altitude` (m) are present; `gap` is not a valid stream type (422 "Invalid stream type") |

- `decoupling` and `icu_efficiency_factor` are null on every activity since 2024-01-01 for this
  account, so the analysis tools' unit convention for both (`decoupling_pct` as a percent;
  `efficiency_factor` as pace/power per heartbeat) is an assumption carried over from the
  intervals.icu UI and the OpenAPI field names, not something observed on a populated value.
  Re-verify against an activity that actually carries these fields before trusting the unit beyond
  the advisory framing the tools already give it.
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
  other runs have auto-pause gaps, see the Phase 1 verified section above).
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

## update-activity live write check (2026-09-25, user-approved, one run)

Controller-run, one write to one activity, approved by the user before running: `update-activity`
changed the activity's name, appended to its description, and set RPE (`icu_rpe`) in a single
call. The re-read confirmed all three changed values. Gear was left untouched (not part of this
write) and, as documented above, cannot be cleared via `PUT /activity/{id}` regardless. Everything
was restored to its original value afterward. Also confirmed: setting `description: ""` with
`descriptionMode: "replace"` clears the description.

`feel` was not exercised by this check (only name, description, and RPE were written), so its
1-strongest-to-5-weakest scale, as described in `update-activity`'s tool description, remains an
assumption, not something observed on a write.
