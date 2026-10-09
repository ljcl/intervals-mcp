# Server architecture

How `apps/server` works: transport, HTTP layer, cache, error taxonomy, and the
single-home rules that stop derived numbers and tool metadata from drifting.

Related docs: [mcp-apps.md](mcp-apps.md) for the UI packages,
[tools.md](tools.md) for the exposed surface,
[operations.md](operations.md) for running a deployed instance.

## Runtime and transport

- Bun (TypeScript). Streamable HTTP on port 3000 (`/mcp`), deployed as a Docker
  container behind an HTTPS tunnel or reverse proxy. Monorepo: Bun workspaces +
  Turborepo (`apps/*`, `packages/*`).
- **2026-07-28 only.** `apps/server/src/mcpEndpoint.ts` serves the
  2026-07-28 revision per request — stateless, `_meta` envelope,
  `server/discover`, `Mcp-Method`/`Mcp-Name` headers, `resultType` plus
  `ttlMs`/`cacheScope` on results — and nothing else. `createMcpHandler` runs
  with `legacy: "reject"`, so a 2025-era request (no envelope claim, e.g. an
  `initialize` handshake) gets HTTP 400 and `-32022`
  UnsupportedProtocolVersion with `data.supported: ["2026-07-28"]`; a 2025-era
  notification gets 202 and is dropped.
- Why no legacy fallback: every served request now passes the SDK's
  header-vs-body check (`-32020` on a mismatch), so a proxy or WAF rule keyed
  on `Mcp-Method`/`Mcp-Name` is sound. A fallback served claim-less requests
  without that check, which let a request carry any headers past such a rule.
  Every request also carries `clientInfo` and gets JSON rather than SSE
  unless the handler streams progress. See #33.
- Protocol sessions are gone with the revision that removed them. No
  `Mcp-Session-Id` is minted; standalone GET/DELETE answer 405.
- The endpoint parses every POST body itself with `parseJsonWithLargeInts` and
  hands the SDK a `parsedBody`. That seam keeps 64-bit ids losslessly intact;
  do not bypass it.
- The `cacheHints` server option stamps a 1-hour `ttlMs` on
  list/read/discover results, because that surface only changes on redeploy.
  `cacheScope` stays on the SDK's `private` default since `/mcp` can sit
  behind `MCP_AUTH_TOKEN`.
- `httpServer.ts` holds what `index.ts` passes to `Bun.serve`: the routes
  and `idleTimeout: 120`. Bun's default idle timeout is 10 s, and a tool call
  that reports progress answers as an SSE stream whose keep-alive comes only
  every 15 s (`SSE_KEEP_ALIVE_MS`, `mcpEndpoint.ts`). So a streamed call that
  waited more than 10 s on intervals.icu was cut with a connection reset
  (#51). The idle timeout must stay above the keep-alive interval;
  `httpServer.test.ts` checks that. A plain JSON reply that is slow to start
  is not cut (verified on Bun 1.4.2). The protocol tests call
  `handleRequest` directly, so they cannot see this.
- Shutdown drains (`createShutdown`, `httpServer.ts`). On SIGTERM or SIGINT,
  `server.stop()` refuses new connections at once and resolves when the
  requests in flight finish. Shutdown waits for that for up to
  `SHUTDOWN_GRACE_MS` (8 s), then `mcp.close()` aborts what is left and the
  process exits. A second signal exits at once. The grace period must stay
  below the time between SIGTERM and SIGKILL (`stop_grace_period` in
  `docker-compose.yml`, 10 s; also Docker's default).

## HTTP layer (`fetchClient.ts`)

All rate-limit awareness and backoff lives here — add retry/limit logic here,
never per-tool.

- Parses `X-RateLimit-*` / `Retry-After` headers into a snapshot
  (`intervalsApi.getRateLimitSnapshot()`); intervals.icu sends none of these
  today (verified 2026-09-24), so the client paces itself instead of reacting
  to headers; see "Request pacing" below.
- Retries 429s honouring `Retry-After` (bounded, so a call never blocks on a
  full 15-minute window).
- Retries transient 5xx and network faults with bounded exponential backoff —
  GET/HEAD only, never writes. Transient includes Cloudflare's 520-524
  (intervals.icu sits behind Cloudflare; these mean Cloudflare got no answer
  from it in time).
- The body read is part of the attempt: the timeout signal covers it, a GET
  whose body stalls or is cut off retries, and a timeout during the read is a
  `RequestTimeoutError` like one during the connect (#52).
- An error body goes into `HttpError.message` only as a one-line summary
  (`summarizeErrorBody`): an HTML page becomes its `<title>`, anything else
  is cut to 200 characters. `handleApiError` uses the same summary. The raw
  body stays on `response.data`, with `response.contentType`. A Cloudflare
  error page once put about 6,000 characters of HTML into a tool error.
- `response.cloudflareChallenge` is true when the response carried
  `cf-mitigated: challenge`: Cloudflare stopped the request before
  intervals.icu, so the API key was never checked.
- An exhausted-limit 429 surfaces as a structured `RateLimitError`.
  `handleApiError` (`intervalsClient.ts`) turns it into an actionable message
  **without flattening it**: the rethrow is the same `RateLimitError`,
  unmodified (`detail` is the bare window description a tool can quote). Every other HTTP failure becomes an
  `IntervalsApiError extends HttpError`, so the status survives the translation.
- Flattening either into a plain `Error` silently breaks callers that degrade
  on type or status (e.g. scan tools' `instanceof RateLimitError` abort). A
  caller may only degrade on a type or a status that is still there.
- Tool-facing error text has one home: `toolErrorText` in
  `tools/_errors.ts`. It maps `RateLimitError` to the window/reset line
  (quoting `detail`), `HttpError.status` 404 to the tool's not-found sentence
  and 402 to its subscription sentence, `response.cloudflareChallenge` to a
  challenge sentence (checked before 401/403, which name
  `INTERVALS_API_KEY`), and everything else to
  `❌ Failed to <context>: <message>`; every `isError` text on the surface
  starts with `❌`. Tool catch blocks and the dispatcher's final catch call it
  for the text and write the `{ content, isError: true }` literal themselves
  (the helper's own comment explains why it is not the whole result). The
  dispatcher's own texts (unknown tool, invalid arguments, missing API key)
  have no error to translate, so they get the prefix from
  `prefixedErrorText` in the same file. Never
  string-match a message for
  "Record Not Found", "404", or a `SUBSCRIPTION_REQUIRED:` prefix: the typed
  errors survive `handleApiError` precisely so callers can branch on them,
  and a message that merely mentions "404" is not a missing record.

## Request pacing

intervals.icu sends no `X-RateLimit-*` or `Retry-After` headers (verified
2026-09-24), so there is nothing in a response to react to. Instead
`intervalsApi` (`fetchClient.ts`) enforces `minIntervalMs: 200`: a minimum
gap between the *start* of consecutive request attempts, shared across
concurrent callers via a single next-available-slot clock, not a per-caller
delay. Draft limits (go-live unconfirmed): 5,000 requests/day and 2,500 per
rolling 15 minutes per key, about 10/s per IP; 200ms spacing stays well under
that ceiling without needing header feedback.

## Response cache

`fetchClient.ts` also owns an opt-in TTL + LRU cache
(`apps/server/src/cache.ts`, `TtlLruCache`) for immutable-ish GETs. Policy
lives in `intervalsCacheTtl`, keyed by request path: add caching there, not
per-tool. Path patterns and current TTLs (`fetchClient.ts`):

| Path | TTL | Rationale |
| ---- | --- | --------- |
| `/activity/{id}/streams*` | 10m | Immutable once intervals.icu has processed the activity |
| `/activity/{id}/intervals` | 10m | Same |
| `/activity/{id}` | 10m | Invalidated on `update-activity` writes |
| `/athlete/{id}/gear` | 10m | Rarely changes |
| `/athlete/{id}/sport-settings/{sport}` | 1h | Rarely changes |
| `/athlete/{id}/sport-settings` | 10m | Every group at once (`get-athlete-zones`); shorter than one sport's settings, so a changed LTHR shows soon |
| `/athlete/{id}/hr-curves.json` | 10m | Recomputed from history, like the pace curves |
| `/athlete/{id}/activities` | 1m | A newly recorded activity should show up quickly |
| `/athlete/{id}/activities/search-full` | 1m | Same freshness as the listing |
| `/athlete/{id}/wellness*` | 5m | intervals.icu updates wellness through the day |
| `/athlete/{id}/pace-curves.json` | 10m | Recomputed from history a few times a day at most |

Everything else is left uncached.

- Date-range reads (`list-activities`, `get-wellness`) key on calendar-day
  `oldest`/`newest` bounds (`YYYY-MM-DD`), not an epoch timestamp, so no
  quantization step is needed: two calls resolving the same default window
  (e.g. `todayLocal(tz)`) build the same query string and hit the same cache
  entry for free. An epoch-based bound would key every call uniquely and the
  TTL would never hit; a calendar-day string already has coarse enough
  granularity that it doesn't.
- Cache key is the full URL (query included, so distinct stream resolutions and
  date windows stay separate); TTL and invalidation match the query-stripped
  path.
- A successful write invalidates every cached read on the same branch —
  descendants (so `update-activity` drops the activity's cached
  detail/streams/zones/laps) **and** ancestors, since a write to a
  sub-resource can change how its parent reads. No current tool writes a
  sub-resource, but `invalidateWritten` (`fetchClient.ts`) still walks both
  directions so a future one is covered without a second rule. This
  automatic invalidation only fires when the PUT itself resolves
  successfully; `updateActivity` (`intervalsClient.ts`) additionally
  invalidates the activity, the athlete's activities list, the gear list,
  and the athlete pace curves (their `activities` map carries the run names
  `get-best-efforts` reports) in a `finally`, so a *failed* PUT that may
  still have mutated state server-side (a 5xx, a network fault, a timeout)
  does not leave a stale pre-write entry being served afterward.
- `skipCache: true` bypasses entirely; the `update-activity` append read uses
  it so it never composes onto a stale description.
- **The cache never shares references.** Every value it hands out (a hit, the
  miss that populated it, a coalesced awaiter's copy) is a `structuredClone`,
  so a consumer may sort, splice, or rename in place without rewriting the
  entry for every later reader inside the TTL. Trade-off: one clone per read;
  payloads are parsed JSON (oversized ids already arrive as digit strings from
  `parseJsonWithLargeInts`), so the copy is lossless. Cloning was chosen over
  deep-freezing because freezing would turn a caller's in-place mutation into
  a strict-mode `TypeError` and change the plain-mutable-data contract every
  handler has today.
- **Concurrent identical cacheable GETs coalesce.** A private in-flight map,
  keyed like the cache, holds the promise for a cacheable GET/HEAD until it
  settles; an identical request arriving meanwhile awaits that promise instead
  of going upstream, which is how an app's `view-`/`get-…-data` pair costs one
  fetch even when both miss together. A rejection reaches every awaiter and
  caches nothing, so the next call fetches again. A write's invalidation walk
  drops matching in-flight entries too, and an entry that was dropped mid
  flight never stores its (pre-write) result. `skipCache` reads bypass the map
  as well as the cache; paths the policy declines are never coalesced.

## Streams

Every stream read goes through `loadIntervalsStreams` in
`intervalsStreams.ts`, never a bare `intervalsApi.get`. It calls
`GET /activity/{id}/streams.json?types=...`, and callers ask for whichever
stream types their tool or app needs; intervals.icu returns each requested
type as `{type, data, data2, valueTypeIsArray, ...}` (`latlng` puts latitude
in `data` and longitude in `data2`; see docs/api-notes.md for the full
response shape and per-type null patterns from a live probe).

Only a genuine 404 or an empty result throws
`IntervalsStreamsUnavailableError`, the one error a caller may degrade on
("this resource has no recorded samples"). It carries the activity id so the
message names what was missing. Catching anything broader misreports other
failures (auth, rate limits) as absences.

**A heart-rate dropout becomes `null` here, once, for every caller.**
intervals.icu sends 0, not `null`, for a heart-rate sample where the sensor
lost contact (docs/api-notes.md). `loadIntervalsStreams` maps every
`heartrate` sample of 0 or below to `null`. A downsampled bucket then
averages only real samples, a bucket with only dropouts is `null`, and the
apps draw a gap. `watts` and `cadence` keep their zeros: 0 W while coasting
and 0 cadence while stopped are real values. The run-power rule (0 W while
moving is a dropout) stays in the analysis modules that read power. The
`hr <= 0` guards in the analysis modules are now defensive only.
`get-activity-streams` once read the client directly and reported the zeros
as 0 bpm (#46).

**`moving` is derived here, once, for every caller.** intervals.icu never
returns a `moving` stream. A sample is stopped when its `velocity_smooth` is
known and below `MOVING_MIN_VELOCITY_MPS` (0.5 m/s), or when the time since
the previous sample is over `MOVING_GAP_THRESHOLD_SECONDS` (5 s) and the
distance across that gap gives a speed below 0.5 m/s. A watch auto-pause is
a time gap with almost no distance, so it is a stop. A gap covered at
running speed is sparse sampling (Garmin "smart recording"), so its time
stays moving time. When `distance` is unknown at either end of a gap, the
gap alone counts as a stop. So the loader always requests `distance`, and
returns it only to a caller that asked for it. The analysis modules keep a
stopped sample's distance but drop its time; before #73 every gap over 5 s
was a stop, and a smart-recording run read at about twice its real pace.
The rule assumes that intervals.icu keeps smart-recording gaps in the
`time` stream; that is not verified yet (docs/api-notes.md).

**A sample with no time is dropped, and the loader counts it.**
`loadIntervalsStreams` drops a sample whose `time` is `null`, with the same
sample in every other stream, and reports how many in `droppedSamples`.
After a drop, an index that intervals.icu gives into the raw streams (an
activity's `ignore_parts`) points at the wrong sample. So `get-best-efforts`
applies those parts only when `droppedSamples` is 0 (#82).

## Analysis math: one home per definition

**Grade-adjusted pace has one definition.** `hillAnalysis.ts`'s `gapFactor`
(Minetti), `computeGrades` (intervals.icu's `grade_smooth`, else an
altitude window) and `gapGrades` (that grade averaged over a centred 100 m
window, clamped to ±30%, plus a noise measure). `splitAnalysis.ts` imports
them rather than re-deriving them, along
with `MAX_SAMPLE_GAP_SECONDS` and `POWER_COVERAGE_MIN`, so a hilly split and a
hilly climb are corrected identically. `gapFactor` never sees a raw
per-sample grade. The Minetti curve is convex, so zero-mean grade noise
applied sample by sample still raises the mean factor (Jensen's
inequality): ±5% noise gave a mean factor of 1.03 and ±10% gave 1.13, so a
noisy barometric track made flat GAP 3% to 13% too fast (#45). The 100 m
average cancels the noise and keeps a steady climb's grade exactly. The RMS
of the raw grade around the average measures the noise; above 3 points,
both tools warn that GAP is approximate. Its own contribution is the distance
binner: `binByDistance` accumulates streams into buckets bounded by a
caller-supplied edge list, dividing a sample interval that straddles a boundary
in proportion — which is why the per-km splits and the exact-midpoint halves
behind the verdict come from one function. Halves are cut at half the recorded
distance, never by grouping splits, so an odd split count or trailing partial
cannot skew the verdict. With no elevation data there is no grade, not a
flat one: `binByDistance` gets no grade, every grade-adjusted figure is
null, and the verdict is on the clock only. `normalizeHillStreams` drops an
altitude stream with no real samples (an `allNull` stream) for the same
reason, and `interpolateNulls` throws on one rather than fill it with 0.
Elevation gain is the activity's own `total_elevation_gain` when it has one,
so `get-split-analysis` and `get-activity` agree; `ascentFromAltitude`
(valley-to-peak climbs with a 3 m hysteresis) is the fallback.

**Running efficiency has one definition.** `speedEfficiencyFactor` in
`aerobicAnalysis.ts`: metres per minute per heartbeat, so higher is better
and a slower pace at a proportionally lower heart rate scores the same.
`get-aerobic-analysis` applies it to stream averages, `compare-activities`
to each run's grade-adjusted speed (or moving speed, on both sides, when
either run has no `gap`). The aerobic tool's default `gap` basis reads
`gradeAdjustedSpeeds` (`hillAnalysis.ts`): `velocity_smooth` times the same
averaged-grade GAP factor the hill and split tools use, so it never builds a
second GAP. On raw speed, an out-and-back course at a steady heart rate
decoupled by -19% one way round and +16% the other; grade-adjusted, both
are about 0% (#74). intervals.icu's own `decoupling` and
`icu_efficiency_factor` never carry a basis label the tool did not compute:
they are the headline only when the caller asks for no basis, and
otherwise sit in their own `intervals_icu` field. `compare-activities` once divided pace by heart
rate instead, where a slower pace and a lower heart rate add up rather than
cancel, and called an unchanged runner "declined" (#42).

**Training-load weeks have one definition.** `trainingLoad.ts` owns the
window (`trainingLoadWindow`: `days` rounded up to whole Monday-to-Sunday
weeks, plus the current week so far), the timeline (`aggregateWeeks`: first
week with any activity to the current week), the weeks the run-based rules
read (`selectRunWeeks`: first week with a run to the current week, zero-run
weeks kept, the week in progress apart), and the rules themselves
(`computeWeekWarnings`, `volumeTrend`). `get-training-load` and the
training-load app feed both call them. A window that started mid-week gave a
steady runner a 1-day first week, then a "200% increase" on the next full
week, and a trend that compared the unfinished current week with full ones.
The app also dropped the zero-run weeks that the text tool kept, so the two
gave different warnings for the same weeks (#43). Only the current week can be
partial now, and no rule uses it as a baseline or in an average.

The timeline and the run weeks used to stop at the last week with activity,
so a layoff that was still going on did not count: an athlete who had not run
for 2 weeks got the averages and a "limited data" trend of the weeks before.
Both now run on to the current week. The warning compares a week with the
average of the complete weeks before it, not with the whole period: with a
whole-period average, the layoff lowered the average and flagged the normal
weeks before it.

`computeWeekWarnings` has one rule: a week over 1.5 times the average of the
4 complete weeks before it (the acute:chronic ratio; 3 weeks at least). A
rise of over 30% on the previous week warned about every normal week after a
recovery, taper or illness week, and a second "unusually high" rule flagged
the same weeks again (#60). So that the first weeks of a window have an
average, `trainingLoadWindow` reaches 4 weeks further back
(`baselineStartDate`) and `loadTrainingLoadInputs` returns those runs as
`baselineRuns`. `baselineWeeks` turns them into weeks, and `selectRunWeeks`
reads them only as the baseline: they never get a row, a total or a warning.

**CTL/ATL/TSB numbers have one home each** (#75), all in `fitnessTrend.ts`.
`ctlAtlTsb` turns raw CTL and ATL into display values: TSB from the raw
values, then each rounded to 0.1. The recurrence, the whole-body wellness
series (`fitnessTrendWellness.ts`) and `get-wellness` all use it. `ctlDelta`
(and `tsbDelta`) gives the change over N calendar days to the last day,
looked up by date, or null when that day is missing. `get-fitness-trend`'s
`ctl_7d_delta`, the steep-ramp bands and the fitness-trend app all read it;
the app gets it as `ctl7dDelta` in its payload, because an MCP App cannot
import server code. The app used to count 7 rows back, and a whole-body
series leaves out days with no wellness, so with 2 missing days it described
9 calendar days as "the last 7 days" and gave a different number from the
text tool.

**HR zone bounds have one home.** `resolveHrZones` in `activityZones.ts`:
the activity's own `icu_hr_zones` first, else the Run sport settings group
when its `types` names the activity's type, else no zones with a note.
`get-activity` (`hr_zones`) and `get-running-summary` (`hr_zone_summary`)
both call it; each only shapes the result.

`zoneRanges` in the same file turns ascending upper bounds into ranges:
zone 1 starts at 0, and each later zone starts at the previous zone's upper
bound. `buildZoneSet` (an activity's zone time) and `athleteZones.ts` (the
athlete's settings: HR and pace zones) both call it. `athleteZones.ts` also
holds the LTHR and max HR checks against intervals.icu's HR curves, used by
`get-athlete-zones`. The LTHR estimate follows intervals.icu's own rule
(`lthrEstimate`): the higher of the best 60-minute heart rate and 98% of the
best 20-minute heart rate, both of the last 90 days.

**Run types have one home.** `PACE_ACTIVITY_TYPES` in `utils/running.ts`
(Run, TrailRun, VirtualRun). `get-running-summary` accepts exactly these,
and `fitnessTrend.ts` re-exports them as `RUN_TYPES` for the run-only series
and `get-training-load`. `STEP_CADENCE_ACTIVITY_TYPES` and
`RUNNING_ACTIVITY_TYPES` add Walk and Hike on purpose: those have a step
cadence but no pace.

**Best efforts inside one activity have one home.** `bestEffortWindows` in
`activityBestEfforts.ts`: for each start sample, the first sample whose
distance reaches the target, with the elapsed time scaled to exactly the
target. This is intervals.icu's own pace-curve rule (it reproduced 313 of
313 activity-curve points, docs/api-notes.md), so `get-best-efforts` with
an `id` agrees with the same tool over a window at every distance the run
fully covers. (A run a few metres short of a distance has no stretch of it,
but over a window it can count for a nearby curve point, such as 21000 m
for a half marathon.) `topN` picks the fastest stretches that do not
overlap. `stopped_seconds` reads the loader's `moving` stream with
`velocity_smooth` loaded, as `get-split-analysis` does, so a stop has one
definition: an auto-pause gap, or a sample under 0.5 m/s.

**Taper solving.** `fitnessTrend.ts` owns every CTL/ATL/TSB number, including
the forward-looking ones — `plannedLoads` projects a prescribed load instead of
rest, and `solveTaperPlan` finds the weekly load taper that lands on a target
form on a target date. TSB after n days is linear in the daily loads, so two
projections (rest, and the taper shape at scale 1) pin a line and the exact
scale follows — no bisection, no tolerance. Fatigue decays faster than fitness,
so the line always slopes down; the two clamps are the honest answers: a target
even complete rest cannot reach in time, and one that would take racing every
day (`MAX_TAPER_DAILY_LOAD`). Both report the form that actually lands rather
than inventing a plan. Keep new projection math here, not in a tool —
`get-fitness-trend` and the fitness-trend app both read one solve.

The solver sizes its day array from the distance to the target date, so the
date is checked before any fetch: `taperTargetDateError` requires a real
calendar date, after today, and at most `MAX_TAPER_DAYS` (180) ahead. The text
tool and both app tools call it. Before #44 the date had only a regex check:
a typo like 2062-10-17 gave a 13,170-day plan of about 950 KB, 9999-12-31
overflowed the call stack in `Math.max(...shape)` (now a loop), and
2027-02-30 rolled over into March.

**Form turning positive has one rule.** `tsbPositiveFrom` in `fitnessTrend.ts`
sets `tsbPositiveDate` for the run-only, whole-body synced and whole-body
lagging paths: today when today's raw TSB is already ≥ 0, else the first
projected date it reaches 0. The projection starts the day after today, so
before #44 a form of +12 today read as "returns positive" tomorrow. The
callers print `tsbPositiveDate === today` as "already positive today".

**Warning bands.** `trendBands` dates every stretch, and `computeFlags` is
the subset that runs to the last day, so the chart and the prose agree. Fresh
bands have hysteresis (start at `FRESH_TSB` +15, hold until TSB drops below
`FRESH_EXIT_TSB` +12), merge across a gap of up to `FRESH_MERGE_GAP_DAYS` (2),
and need `FRESH_MIN_DAYS` (3) unless they run to the last day. Before #44, TSB
moving around +15 for 42 days gave 8 fresh bands, 6 of them 1 day long, and
the chart showed stripes. Reasons are in the present tense only for the bands
that are also flags; a band that ended earlier reads in the past tense.

**Interval detection pairs by adjacency.** `computeIntervalAnalysis` in
`intervalAnalysis.ts` builds work segments and rests in one ordered pass, and
each rest records the segment that ends right before it. The rests and
segments were paired by array position (`segments[i]`, `rests[i - 1]`), so a
standing start (a rest with no segment before it) judged every later rest by
the segment after it (#47). The near-max HR share is measured against the
athlete's max HR (`athlete_max_hr`, else the top `icu_hr_zones` bound), never
the run's own peak, which made an easy run read as hard. The lap path drops
sliver laps rather than the whole lap set, and needs 2 blocks of consecutive
fast laps with slower laps between; `selectCleanWorkLaps` holds the lap
rules, including the stricter test for 1 km or 1 mile auto-laps.

## Per-call telemetry

`dispatchToolCall` is timed end to end and emits one structured JSON line per
call via `telemetry.ts`: tool name, duration, outcome, error class, the
rate-limit snapshot, and which client made the call (`client_apps`,
`client_name`). The timer starts **before token resolution**, so a
not-connected call is recorded too — it cost the caller a round trip. A
handler returning `isError` counts as an error alongside a throw, or the
counters would flatter the server. `recordToolCall` can never fail the call it
describes: the snapshot read and the serialize are both guarded, because a
logging fault turning a successful call into an error is worse than a missing
log line. The rolling counters back the authed half of `/health`.

The client fields come from the request envelope. The `tools/call` handler
reads the `io.modelcontextprotocol/clientCapabilities` and
`io.modelcontextprotocol/clientInfo` keys off `ctx.mcpReq.envelope` (the
shipped envelope type is `{}`, so by key, with a cast) and passes
`client: { rendersApps, name }` to `dispatchToolCall`. `client_apps` is
`clientSupportsMcpApps(capabilities)`: the client advertised
`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`. The same
boolean reaches each handler as the fourth argument (`ToolCallContext`), and the
`view-*` handlers use it to choose their footer, so a result never claims a
rendered chart to a host that does not render one (#77). A call dispatched
without client information records `client_apps: false`. A host that renders
apps without advertising them gets the "cannot display" text too; the log
field is how an operator sees how many calls that affects.

The records stay with the operator: the stderr line and the `/health`
counters. The server does not advertise the `logging` capability, because
the 2026-07-28 revision deprecates it (SEP-2577), and a record holds nothing
the caller does not already know (#72). A request that carries the
`io.modelcontextprotocol/logLevel` envelope key gets its normal response and
no `notifications/message`.

## Progress notifications

A caller's `progressToken` becomes a `ReportProgress` closure (`progress.ts`),
passed to every handler as its third argument — always present (`NO_PROGRESS`
when none was requested), so a tool never checks whether progress was asked
for.

- `progress` is a plain **tick counter with no `total`**, and the count lives
  in the message: the spec requires one token's progress to strictly increase,
  and a call with several phases ("page 3 of ?", then "activity 87 of 120")
  cannot carry two denominators in one monotonic number.
- The throttle is **time-based** (`MIN_PROGRESS_INTERVAL_MS`): a pool finishing
  50 activities in a second is one line of news, not 50.
  `important: true` bypasses it for phase changes and rate-limit aborts.
- Counts from a bounded pool are completion-ordered, not index-ordered.
- `listActivities` (`intervalsClient.ts`) takes the reporter as an optional
  third argument and reports each 31-day window of a longer scan ("window 3
  of 17"); callers pass theirs through. A run-only lookback of 515 days is 17
  requests in a row, and before #51 it sent nothing between them.
- Sends are fire-and-forget; every failure is swallowed.
- Client side, `useServerToolData` and `useServerToolFetcher` (per key) share
  `progressCallOptions`. It sets `resetTimeoutOnProgress` (so a live sweep is
  not killed by the host's default timeout), and each hook exposes the latest
  message for `LoadingState` to render.

## API key access

`dispatchToolCall` resolves the intervals.icu API key once per call via
`getIntervalsApiKey()` (`apps/server/src/config.ts`) and passes it to the
handler as its second argument. Tools never read
`process.env.INTERVALS_API_KEY`; adding a tool means accepting
`(args, token)`, not adding a guard. A missing or blank key throws a typed
`MissingApiKeyError`; dispatch maps that to one not-configured message naming
`INTERVALS_API_KEY`.

## Resource ids

Every tool argument naming an activity id goes through
`intervalsActivityIdInput` (`apps/server/src/tools/_ids.ts`), never an
ad-hoc `z.number()` or `z.union([z.number(), z.string()])`. It accepts an
optional `i` prefix (e.g. `i189807578`); a string id passes through as given,
prefix and all, which the API accepts.

Some ids already exceed 2^53, so an id sent as a JSON number is rounded by the
host's `JSON.parse` before validation sees it and the true digits are
unrecoverable. The schema therefore advertises ids as **string only**
(`idJsonSchemaOverride`, applied in `toInputSchema`) so a host cannot generate
the lossy shape, while still
accepting a safe-integer number at runtime and normalising every id to its
digit string. `mcpEndpoint.ts` parses the inbound `/mcp` body with
`parseJsonWithLargeInts` for the same reason, and handlers pass ids through as
strings rather than parsing them back.

Every activity-id input except `update-activity`'s accepts the special value
`"latest"`, which means the newest Run, TrailRun, or VirtualRun in the last
366 days. Resolution happens once per call by `resolveLatestIds` (`latestActivity.ts`)
in `dispatchToolCall` after validation, walking 31-day windows newest first and
stopping at the first run, from cached `listActivities` reads. If no run is
found, the tool returns an `isError` result naming the fix. `update-activity`
cannot use `"latest"` because a write must name its specific target; it validates
against digits only.

`dispatchToolCall` records what `"latest"` resolved to: the keys it
changed (`id`, or `activityId1`/`activityId2`) go into the result's
`_meta["intervals-mcp/resolvedArgs"]` (`RESOLVED_ARGS_META_KEY`,
`latestActivity.ts`), only on a successful call that resolved one. The id is
not in the result text, and hosts do not generally pass `_meta` to the model.
An app pins its own arguments to it (`useHostRoot`, docs/mcp-apps.md), so a
re-mounted view stays on the same run rather than a newer one, and the host
can read the resolved id from `_meta`.

## Structured output

A tool that returns data publishes an `outputSchema` and a matching
`structuredContent`, so a caller chains on fields instead of regexing ids out
of prose. Schemas live in `tools/outputs.ts`, **grouped, not per file**:
`PaceSchema` is defined once and reused (extended where a tool needs extra
fields) across training-load, running-summary, best-efforts, race-prediction,
and lap output schemas, so pace formatting cannot drift between tools that
report it. `warnOnSchemaDrift` validates every
payload outside production, so a shape that stops matching its schema is noisy
in dev rather than silently wrong in a host. `get-activity-zones` deliberately
reuses `mapIntervalsZones` (the activity-zones app's mapper) so the text tool
and the chart cannot describe different zones. Empty results still emit a valid
payload (`count: 0`), because a caller branching on `structuredContent` should
not have to handle "absent" as a third case.

## Response size budget

Every model-visible tool response, text plus the `structuredContent` JSON,
stays under `RESPONSE_BUDGET_CHARS` (40,000 characters, `tools/_responseBudget.ts`).
Some hosts forward both copies to the model, and Claude Code refuses a result
over 25,000 tokens: a 61 KB `get-activity-streams` payload and a 150 KB
`get-race-prediction` one both shipped before the budget existed (#40, #41).

- A tool whose input can ask for more than fits measures the built response
  and shrinks it, rather than reject the call or change the schema:
  `get-activity-streams` re-downsamples to fewer points, `list-activities`
  returns a shorter page with `truncated: true`. The text says what was cut
  and how to get the rest. Measuring beats a fixed cell cap because widths
  differ (a `latlng` cell costs about four `heartrate` cells).
- A response that a closed set bounds, not an input, needs no shrink.
  `get-athlete-stats` lists one row per activity type in each of its four
  periods, and the spec's type enum lists 60 (`Activity.type` itself is a plain string). Its "every activity type" size
  case puts all 60 in every period (about 32,000 characters). If that case
  goes over the budget, add a measured shrink.
- A text response never points at data the reader cannot reach. Some hosts
  pass only the text, so "(N more)" names the call that returns the rest
  ("get-activity-laps lists all 34"), or the cap is raised where no tool
  does.
- `responseSize.test.ts` runs every model-visible tool through
  `dispatchToolCall` at its largest inputs against fixtures sized to fill
  them, and fails on a tool with no case, so a new tool cannot skip it.
  `scripts/live-check.ts` prints each response's size and flags one over
  budget. App-only data feeds never reach the model and are not budgeted
  (their payload size is #71).

## Input validation

**Another tool's spelling of a shared input is accepted, never advertised.**
`dispatchToolCall` runs `normalizeArgs` (`argAliases.ts`) before `safeParse`,
driven by each tool's advertised JSON schema rather than a per-tool table
(#78). It renames an activity-id spelling (`id`, `activity_id`, `activityId`;
`activityId1`, `activity_id_1`, `id1` and the same for 2) to the one the tool
takes, and a camelCase/snake_case variant (`max_points`) to the tool's key,
only when the tool's own key is absent. It matches an enum value ignoring
case, spaces, hyphens and underscores, with a trailing "k" read as "km"
("Half Marathon", "5K"), only when exactly one option matches. The
advertised schemas and `tool-surface.lock.json` do not change. A call that
still fails validation gets `unknownArgsText` appended, naming each key the
tool does not take and the keys it does. A call that passes drops unknown
keys, so its reply ends with an `ignoredArgsText` line naming them and the
keys the tool takes (#151), never an answer that reads as if they were used.

**One naming scheme for inputs.** The alias layer above exists for models and
hosts that still use older spellings; the advertised schemas follow this
scheme:

- Inputs are camelCase. A single activity id is `id`; a pair is
  `activityId1`/`activityId2`. The app tools and their data feeds take them
  (`activity_id` and `activity_id_1`/`activity_id_2` are accepted, never
  advertised). Prompts are outside the lock and follow it too
  (`annotate-last-run` takes `id`, still accepting `activity_id`).
- Outputs (`structuredContent`) stay snake_case.
- Distance labels are one set across tools, lowercase with explicit units:
  `400m`, `1km`, `5km`, `10km`, `15km`, `10 mile`, `half marathon`,
  `marathon`, `50km`. `get-race-prediction` uses `5km`, `10km`, `15km`,
  `10 mile`, `half marathon`, `marathon`, `50km`; "5K"/"Half Marathon" still
  match through the alias layer.
- `sport` picks a sport settings group (`get-athlete-zones`), matched against
  each group's `types`. It is not an activity filter, which is `type`
  (`list-activities`).
- Windows: `oldest`/`newest` for an explicit range, `days` for a look-back.
  `view-cadence-trends` and `get-cadence-trend-data` take `days` (7-728,
  default 42) and the payload carries `days`; a `weeks` argument becomes
  `days: weeks * 7` through the alias layer.
- `get-best-efforts` is the one exception, and it stays one on purpose
  (#82): it advertises `window` ("all", "1y", "90d", or
  "YYYY-MM-DD..YYYY-MM-DD"), because "all", "1y" and "90d" are
  intervals.icu's own pace-curve ids, which have no `oldest`/`newest` form.
  The alias layer reads `oldest`/`newest`/`days`/`weeks` as a `window`
  range when no `window` and no `id` is sent (#151): the range ends at
  `newest` or today, and starts at `oldest`, else `days` back inclusive,
  else a year back. With an `id` the range keys stay unread, and the
  ignored-arguments note names them.

Changing an advertised name changes `tool-surface.lock.json` (see the
tool-identity invariant in CLAUDE.md), so it is a deliberate release note.

**`update-activity` validates against fresh reads, not cached ones.** Its
input schema (`superRefine`, `tools/updateActivity.ts`) rejects a `name`
that is empty or whitespace-only, and rejects `descriptionMode` without
`description`; `append` mode additionally rejects an empty or
whitespace-only `description` (an empty string in `replace` mode is the
explicit way to clear a description instead; `null` and `""` are
treated as equal when diffing, so clearing an already-empty description
sends no PUT). `gearId` is checked against a `skipCache: true` `list-gear`
read, so gear added moments earlier is accepted; an unknown id fails and
lists the available gear ids and names, while a retired id is accepted with
a warning. The activity itself is also read fresh (`skipCache: true`)
before gear validation, so a missing activity reports not-found rather than
an unrelated gear error. Between those two reads, a `description` with no
`descriptionMode` is refused, with no further request, when it would drop
existing text: the activity's description is not blank, and the new text
does not contain it (compared trimmed). The error previews that text and
asks for `append` or `replace`. An explicit `replace` still writes, and its
text reply quotes the text it removed, because some hosts drop
`structuredContent` and with it `changes[].before` (#49).
`utils/activityWrite.ts` holds the pure, unit-tested pieces this depends
on: `buildActivityPatch` (keeps only fields that differ from the current
value), `diffActivityWrite` (before/after echoes plus a warning when a
fresh re-read does not match what was sent), `composeDescription`
(replace/append), and `discardedDescription` (the existing text a write
would drop, shared by that refusal and the reply).

**A write that may have landed is never silently treated as failed.**
`update-activity` (`tools/updateActivity.ts`) can tell a definite rejection
of the PUT from an ambiguous one: a 4xx `HttpError` (the request itself was
rejected, e.g. a bad gear id) or a `RateLimitError` (throttled before it
ran) never reached the write, so those report a normal error. Anything
else (the PUT times out (`RequestTimeoutError`), returns a 5xx, a network
fault, or the client fails to parse an otherwise-200 response) leaves the
write's outcome unknown, same as a failure after the PUT resolved (the
confirming re-read, or diffing its response). All of these report an
`isError` that says so explicitly and points at `get-activity` to check
before sending the same update again, rather than either claiming success,
reporting a flat failure, or inviting a blind retry that could double the
effect of a write that already landed.

## Tool metadata

**Permissions.** Every tool takes one of the three annotation constants in
`apps/server/src/tools/_annotations.ts` — never an inline `annotations`
object. These are user-facing: hosts bucket tools into "read-only" (grantable
once) and "write/delete" (re-prompts forever) from them. `READ_ONLY` states
`destructiveHint: false` even though the spec calls it meaningless alongside
`readOnlyHint: true`, because the documented **default is `true`** and a host
that checks it first files every read tool under write/delete. Nothing may set
`_meta["anthropic/requiresUserInteraction"]`: it forces a prompt on every call
with no "don't ask again", and allow-rules do not skip it.

**Identity is a published contract.** Grants are stored against a tool's name
and schema, so renaming a tool or reshaping its input schema silently drops
every athlete's "Allow always". `apps/server/tool-surface.lock.json`
fingerprints `name + annotations + inputSchema + outputSchema + _meta` per tool
(description excluded — model-facing prose would churn the lock), and
`toolSurface.test.ts` fails on drift, naming which existing tools changed.
Breaking the lock is allowed, just deliberate:

```bash
cd apps/server && UPDATE_TOOL_SURFACE_LOCK=1 bunx vitest run src/toolSurface.test.ts
```

Say so in the PR when you regenerate — users pay with one round of
re-prompting.

**Titles and instructions.** Every tool, prompt and app resource has a
display `title`, and so does `serverInfo`. A host that shows titles then
shows "Running summary" instead of `get-running-summary`. Titles are outside
the lock, like descriptions. `annotations.title` is inside it, so the server
never sets it. `serverInstructions` (`instructions.ts`) builds the short
orientation that `server/discover` sends to every chat: where ids come from,
which tool to call first for one run, how to route fitness questions, the
whole-body versus run-only rule, units and the configured time zone, and how
to use `update-activity` safely. `createServer` builds it so that it can name
the time zone. docs/Intervals_MCP_Server.md stays the long form. The
integration suite checks the 1,800-character cap and that every tool the
text names exists.

## Protocol-surface testing

Protocol-surface tests go over the wire. `mcpTestClient.ts`
(`connectTestClient(name)`) drives a real exchange through
`createMcpEndpoint(createServer)`: it stamps the `io.modelcontextprotocol/*`
envelope keys into `params._meta` plus the `Mcp-Method`/`Mcp-Name` headers,
reads capabilities from `server/discover`, and parses bare JSON or SSE
(`parseResponse` picks the response out from among notifications either way).

`server.integration.test.ts` runs the whole surface — every capability, a
well-formed object `inputSchema` per tool (no `$ref`: a host cannot resolve
one against a document it never gets), every id advertised as a string,
`structuredContent` alongside the text, `isError` rather than a JSON-RPC
error for a rejected argument, the app resources and their `_meta.ui`, the
prompts, the server instructions, and the display titles — and pins the
result envelope (`resultType`, cache fields, per-response `serverInfo`).
`mcpEndpoint.test.ts` pins the rejection of 2025-era traffic, including a
claim-less `tools/call` with a spoofed `Mcp-Name`.
Asserting against the in-memory `TOOL_DEFS` table proves nothing: an annotation or
schema that does not serialize cannot influence a host. The bootstrap was
copied into three suites before the shared client existed; add to the client
rather than making a fourth copy.

## Testing the MCP endpoint by hand

```bash
# Health check
curl http://localhost:3000/health

# 2026-07-28 request — no handshake; the envelope rides in params._meta
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Method: server/discover" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1.0"}, "io.modelcontextprotocol/clientCapabilities": {}}}}'
```
