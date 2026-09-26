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
  GET/HEAD only, never writes.
- An exhausted-limit 429 surfaces as a structured `RateLimitError`.
  `handleApiError` (`intervalsClient.ts`) turns it into an actionable message
  **without flattening it**: the rethrow is still a `RateLimitError` (caller
  context prefixed onto `message`; `detail` remains the bare window description
  a tool can quote). Every other HTTP failure becomes an
  `IntervalsApiError extends HttpError`, so the status survives the translation.
- Flattening either into a plain `Error` silently breaks callers that degrade
  on type or status (e.g. scan tools' `instanceof RateLimitError` abort). A
  caller may only degrade on a type or a status that is still there.
- Tool-facing error text has one home: `toolErrorText` in
  `tools/_errors.ts`. It maps `RateLimitError` to the window/reset line
  (quoting `detail`), `HttpError.status` 404 to the tool's not-found sentence
  and 402 to its subscription sentence, and everything else to
  `❌ Failed to <context>: <message>`; every `isError` text on the surface
  starts with `❌`. Tool catch blocks and the dispatcher's final catch call it
  for the text and write the `{ content, isError: true }` literal themselves
  (the helper's own comment explains why it is not the whole result). Never
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
| `/athlete/{id}/activities` | 1m | A newly recorded activity should show up quickly |
| `/athlete/{id}/wellness*` | 5m | intervals.icu updates wellness through the day |
| `/athlete/{id}/pace-curves.json`, `/activity-pace-curves.json` | 10m | Recomputed from history a few times a day at most |

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
  invalidates the activity, the athlete's activities list, and the gear
  list in a `finally`, so a *failed* PUT that may still have mutated state
  server-side (a 5xx, a network fault, a timeout) does not leave a stale
  pre-write entry being served afterward.
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

## Analysis math: one home per definition

**Grade-adjusted pace has one definition.** `hillAnalysis.ts`'s `gapFactor`
(Minetti) and `computeGrades` (intervals.icu's `grade_smooth`, else an
altitude window). `splitAnalysis.ts` imports both rather than re-deriving them, along
with `MAX_SAMPLE_GAP_SECONDS` and `POWER_COVERAGE_MIN`, so a hilly split and a
hilly climb are corrected identically. Its own contribution is the distance
binner: `binByDistance` accumulates streams into buckets bounded by a
caller-supplied edge list, dividing a sample interval that straddles a boundary
in proportion — which is why the per-km splits and the exact-midpoint halves
behind the verdict come from one function. Halves are cut at half the recorded
distance, never by grouping splits, so an odd split count or trailing partial
cannot skew the verdict. With no elevation stream, grades are all zero and GAP
collapses onto raw pace: the response warns rather than presenting an
uncorrected verdict as corrected.

**Running efficiency has one definition.** `speedEfficiencyFactor` in
`aerobicAnalysis.ts`: metres per minute per heartbeat, so higher is better
and a slower pace at a proportionally lower heart rate scores the same.
`get-aerobic-analysis` applies it to stream averages, `compare-activities`
to each run's grade-adjusted speed (or moving speed, on both sides, when
either run has no `gap`). `compare-activities` once divided pace by heart
rate instead, where a slower pace and a lower heart rate add up rather than
cancel, and called an unchanged runner "declined" (#42).

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

## Per-call telemetry

`dispatchToolCall` is timed end to end and emits one structured JSON line per
call via `telemetry.ts`: tool name, duration, outcome, error class, and the
rate-limit snapshot. The timer starts **before token resolution**, so a
not-connected call is recorded too — it cost the caller a round trip. A
handler returning `isError` counts as an error alongside a throw, or the
counters would flatter the server. `recordToolCall` can never fail the call it
describes: the snapshot read and the serialize are both guarded, because a
logging fault turning a successful call into an error is worse than a missing
log line. The rolling counters back the authed half of `/health`.

The advertised `logging` capability has no `logging/setLevel` (the
2026-07-28 revision removed it). The dispatcher's records reach only callers
whose request carries the `io.modelcontextprotocol/logLevel` envelope key — which is also that revision's MUST-NOT-emit-unrequested gate —
and `ctx.mcpReq.log` applies their threshold.

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
- Sends are fire-and-forget; every failure is swallowed.
- Client side, `useServerToolData` sets `resetTimeoutOnProgress` (so a live
  sweep is not killed by the host's default timeout) and exposes the latest
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
optional `i` prefix (e.g. `i189807578`) and normalises to the digit string.

Some ids already exceed 2^53, so an id sent as a JSON number is rounded by the
host's `JSON.parse` before validation sees it and the true digits are
unrecoverable. The schema therefore advertises ids as **string only**
(`idJsonSchemaOverride`, applied in `toInputSchema`) so a host cannot generate
the lossy shape, while still
accepting a safe-integer number at runtime and normalising every id to its
digit string. `mcpEndpoint.ts` parses the inbound `/mcp` body with
`parseJsonWithLargeInts` for the same reason, and handlers pass ids through as
strings rather than parsing them back.

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

## Input validation

**`update-activity` validates against fresh reads, not cached ones.** Its
input schema (`superRefine`, `tools/updateActivity.ts`) rejects a `name`
that is empty or whitespace-only, and rejects `descriptionMode` without
`description`; `append` mode additionally rejects an empty or
whitespace-only `description` (`replace` mode's default, an empty string, is
the explicit way to clear a description instead; `null` and `""` are
treated as equal when diffing, so clearing an already-empty description
sends no PUT). `gearId` is checked against a `skipCache: true` `list-gear`
read, so gear added moments earlier is accepted; an unknown id fails and
lists the available gear ids and names, while a retired id is accepted with
a warning. The activity itself is also read fresh (`skipCache: true`)
before gear validation, so a missing activity reports not-found rather than
an unrelated gear error. `utils/activityWrite.ts` holds the pure, unit-tested
pieces this depends on: `buildActivityPatch` (keeps only fields that differ
from the current value), `diffActivityWrite` (before/after echoes plus a
warning when a fresh re-read does not match what was sent), and
`composeDescription` (replace/append).

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

**Permissions.** Every tool takes one of the four annotation constants in
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
error for a rejected argument, the app resources and their `_meta.ui`, and
the prompts — and pins the result envelope (`resultType`, cache fields,
per-response `serverInfo`). `mcpEndpoint.test.ts` pins the rejection of
2025-era traffic, including a claim-less `tools/call` with a spoofed
`Mcp-Name`.
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
