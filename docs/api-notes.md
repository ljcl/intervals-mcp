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
- `GET /athlete/0/sport-settings/Run`: `lthr` 179, `max_hr` 197, `hr_zones` [147,160,169,178,197]; `threshold_pace` and `pace_zones` null.
- `GET /athlete/0/gear` returns Gear objects `{ id (numeric string, e.g. "71459"), name, type ("Shoes"), distance (metres, includes the starting distance entered in the UI), activities (count), retired (null when active), reminders ([]) }`.
- `PUT /activity/{id}` with `{"gear":{"id":"<gearId>"}}` returns 200 and assigns the gear: the activity then reads `gear: { id, name: null, distance: null, primary: null }` (name is not populated on the activity; resolve it via the gear list), and the gear's `distance` increases by the activity distance and `activities` by 1 (54000 to 62030.29 m on the test).
- `{"gear": null}` and `{"gear": {"id": null}}` both return 200 but are ignored: gear cannot be cleared this way. `update-activity` should support switching gear, not clearing it.
- Missing activity returns HTTP 404 with a small JSON body.
- Responses carry no `X-RateLimit-*` or `Retry-After` headers (only Cloudflare headers).
- An activity's (and each interval's) `gap` field is grade-adjusted speed in m/s, the same unit as
  `average_speed`: not documented by the spec, but verified in Task 6 by checking `gap` sits in the
  same range as `average_speed` and that each interval's `gap` tracks its `average_speed` up or
  down with the interval's grade direction, the signature of a grade-adjusted speed rather than a
  pace-per-metre value. See `gapPace` in `apps/server/src/tools/getActivity.ts` for the conversion
  to a pace string with `metersPerSecToPace`.
