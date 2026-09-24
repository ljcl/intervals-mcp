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
- Response headers: unverified. Phase 1 records which `X-RateLimit-*` / `Retry-After` headers appear.

## Open questions for Phase 1
1. Gear write: does `PUT /activity/{id}` accept `{"gear":{"id":"<gearId>"}}` or `{"gear_id":"<gearId>"}`? Re-read the activity and gear totals.
2. Running-dynamics stream names on a real HealthFit (Apple Watch) upload.
3. What a Strava-sourced stub looks like, and which field (`source`, `file_type`) marks it. `GET /activity/{id}/file`'s spec summary notes "Strava activities not supported" for the original-file download; confirm what the activity record itself looks like for one.
4. Rate-limit headers actually sent.
5. Whether `GET /activity/{id}?intervals=true` is needed for laps and interval averages.
