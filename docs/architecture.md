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
- **Dual era via one factory.** `apps/server/src/mcpEndpoint.ts` serves the
  2026-07-28 revision per request — stateless, `_meta` envelope,
  `server/discover`, `Mcp-Method`/`Mcp-Name` headers, `resultType` plus
  `ttlMs`/`cacheScope` on results — and serves 2025-era clients through the
  SDK's stateless legacy fallback until they migrate. One `createServer`
  factory backs both legs so the eras cannot drift.
- Protocol sessions are gone with the revision that removed them. No
  `Mcp-Session-Id` is minted (the 2025 spec always made it server-optional);
  standalone GET/DELETE answer 405.
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

- Parses Strava's `X-RateLimit-*` / `Retry-After` headers into a snapshot
  (`stravaApi.getRateLimitSnapshot()`).
- Retries 429s honouring `Retry-After` (bounded, so a call never blocks on a
  full 15-minute window).
- Retries transient 5xx and network faults with bounded exponential backoff —
  GET/HEAD only, never writes.
- An exhausted-limit 429 surfaces as a structured `RateLimitError`.
  `handleApiError` (`stravaClient.ts`) turns it into an actionable message
  **without flattening it**: the rethrow is still a `RateLimitError` (caller
  context prefixed onto `message`; `detail` remains the bare window description
  a tool can quote). Every other HTTP failure becomes a
  `StravaApiError extends HttpError`, so the status survives the translation.
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

## Response cache

`fetchClient.ts` also owns an opt-in TTL + LRU cache
(`apps/server/src/cache.ts`, `TtlLruCache`) for immutable-ish GETs. Policy
lives in `stravaCacheTtl`, keyed by request path — add caching there, not
per-tool.

| Path | TTL | Rationale |
| ---- | --- | --------- |
| Activity streams | 6h | Immutable once the activity is recorded |
| Detailed activity + laps/zones | 1h | Invalidated on `update-activity` writes |
| Athlete profile/stats | 5m | Name/weight/gear and totals can drift |
| `/athlete/activities` | 2m | Cadence-trends, training-load, and fitness-trend pairs each run a full history pagination |

- Handlers floor `after`/`before` window bounds to the minute
  (`quantizedEpochAfter`/`quantizedEpochBefore` in `server.ts`) so a pair's two
  calls build one URL. Without quantization a raw `Date.now()` per call keys
  every scan uniquely and the TTL never hits.
- Cache key is the full URL (query included, so distinct stream resolutions and
  date windows stay separate); TTL and invalidation match the query-stripped
  path.
- A successful write invalidates every cached read on the same branch —
  descendants (so `update-activity` drops the activity's cached
  detail/streams/zones/laps) **and** ancestors, since a write to a
  sub-resource can change how its parent reads. No current tool writes a
  sub-resource, but `invalidateWritten` (`fetchClient.ts`) still walks both
  directions so a future one is covered without a second rule.
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

Every stream read goes through the `stravaClient.ts` wrapper —
`getActivityStreams()` — never a bare `stravaApi.get`. It runs through one
private `fetchStreamSet` core, so the contract is stated once: it validates
the `[{type, data}]` shape and routes failures through `handleApiError`.
`stravaClient.ts` itself is transitional (see its module comment): every
request sends no `Authorization` header, so it always fails with 401, which
`handleApiError` turns into a message naming the tool as not yet ported to
intervals.icu; a 429 still gets the structured rate-limit message.

Only a genuine 404 or empty response throws `StreamsUnavailableError` — the
one error a caller may degrade on ("this resource has no recorded samples").
It carries `resourceId` + `kind` (`activity`) so the message names what was
missing. Catching anything broader misreports failures (expired tokens, rate
limits) as absences.

## Analysis math: one home per definition

**Grade-adjusted pace has one definition.** `hillAnalysis.ts`'s `gapFactor`
(Minetti) and `computeGrades` (Strava's `grade_smooth`, else an altitude
window). `splitAnalysis.ts` imports both rather than re-deriving them, along
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

The advertised `logging` capability is backed by a real `logging/setLevel`
handler (the v2 SDK registers one whenever the capability is declared;
declaring without a handler answers `-32601`). Stateless legacy serving has
nowhere to keep a session level, so the dispatcher's records reach only
2026-07-28 callers whose request carries the `io.modelcontextprotocol/logLevel`
envelope key — which is also that revision's MUST-NOT-emit-unrequested gate —
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

Every tool argument naming a Strava id goes through `stravaIdInput`
(`apps/server/src/tools/_ids.ts`) — never an ad-hoc `z.number()` or
`z.union([z.number(), z.string()])`.

Strava ids are 64-bit and route/segment-effort ids already exceed 2^53, so an
id sent as a JSON number is rounded by the host's `JSON.parse` before
validation sees it and the true digits are unrecoverable. The schema therefore
advertises ids as **string only** (`stravaIdJsonSchemaOverride`, applied in
`toInputSchema`) so a host cannot generate the lossy shape, while still
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
reuses `mapActivityZones` — the activity-zones app's mapper — so the text tool
and the chart cannot describe different zones. Empty results still emit a valid
payload (`count: 0`), because a caller branching on `structuredContent` should
not have to handle "absent" as a third case.

## Exports

Exports have two delivery modes (`tools/_exportOutput.ts`): the transport is
remote, so a path inside the container is unreachable and file-only exports
were dead over the wire. `output: "content"` returns the document, `"file"`
writes it, and **omitting it** picks file when `ROUTE_EXPORT_PATH` is set and
content when it is not — a published default could only have been right for
one deployment. Content mode caps at `MAX_EXPORT_CONTENT_BYTES` and says
outright that a truncated GPX will not open, rather than handing back something
that looks complete.

## Input validation

**`sportType` is an enum, not a string.** `SPORT_TYPES` in
`utils/activityWrite.ts` is the single list behind both the advertised JSON
Schema and the runtime check, so a model picks a valid value without a failed
round-trip to Strava. It is pinned from Strava's documented SportType model
because there is no machine-readable feed — the cost is that a sport Strava
adds later is rejected locally until the array is updated. Rejections name the
near miss (`Weightlifting` → `WeightTraining`), since an error listing fifty
values is complete but not actionable.

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

Protocol-surface tests go over the wire, in both eras. `mcpTestClient.ts`
(`connectTestClient(name, era)`) drives a real exchange through
`createMcpEndpoint(createServer)`: legacy does the `initialize` handshake then
parses SSE `data:` lines; modern skips the handshake, stamps the
`io.modelcontextprotocol/*` envelope keys into `params._meta` plus the
`Mcp-Method`/`Mcp-Name` headers, reads capabilities from `server/discover`, and
parses bare JSON or SSE (`parseResponse` picks the response out from among
notifications either way).

`server.integration.test.ts` runs the whole surface under
`describe.each(ERAS)` — every capability, a well-formed object `inputSchema`
per tool (no `$ref`: a host cannot resolve one against a document it never
gets), every id advertised as a string, `structuredContent` alongside the text,
`isError` rather than a JSON-RPC error for a rejected argument, the app
resources and their `_meta.ui`, and the prompts. A tool one era serves and the
other drops is exactly what dual-era serving must not allow. Era-specific
describes pin the modern result envelope (`resultType`, cache fields,
per-response `serverInfo`) and that none of it leaks onto the legacy wire.
Asserting against the in-memory `TOOLS` table proves nothing — an annotation or
schema that does not serialize cannot influence a host. The bootstrap was
copied into three suites before the shared client existed; add to the client
rather than making a fourth copy.

## Testing the MCP endpoint by hand

```bash
# Health check
curl http://localhost:3000/health

# Legacy-era (2025-06-18) handshake — served statelessly, no session id comes back
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}}'

# Modern-era (2026-07-28) request — no handshake; the envelope rides in params._meta
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Method: server/discover" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1.0"}, "io.modelcontextprotocol/clientCapabilities": {}}}}'
```
