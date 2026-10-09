# Operations

Running and operating a deployed instance: configuration, the API key, health,
rate limits, and endpoint security. For the code behind these see
[architecture.md](architecture.md).

## Environment variables

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `INTERVALS_API_KEY` | Yes | intervals.icu personal API key (Settings, Developer Settings) |
| `INTERVALS_ATHLETE_ID` | No | Athlete id: `0` (default, the API key's own athlete), a number, or i-prefixed such as `i12345` |
| `TZ` | No | IANA zone for today and default date ranges, e.g. `Australia/Sydney`. Unset, blank or exactly `UTC` (compose's default) means the athlete's intervals.icu time zone ([Time zone](#time-zone)); `Etc/UTC` pins UTC; an unknown zone stops startup |
| `MCP_AUTH_TOKEN` | No | Shared secret; when set, `/mcp` and the detailed half of `/health` require `Authorization: Bearer <token>` (or `?token=` for `/health`). Use at least 32 characters; a shorter one logs a startup `WARNING`, and surrounding whitespace stops startup |
| `PORT` | No | Server port, 1-65535; blank or unset means `3000`. The image's `HEALTHCHECK` reads it |
| `PUBLIC_URL` | No | Public URL, used only to warn when `/mcp` is exposed without `MCP_AUTH_TOKEN` |

### Startup checks

The server checks its configuration before it listens. Each of these prints
one line that names the variable: a missing `INTERVALS_API_KEY`, a `TZ` that
`Intl` does not know, a `PORT` outside 1-65535, a malformed
`INTERVALS_ATHLETE_ID`, and an `MCP_AUTH_TOKEN` with surrounding whitespace.
The server reports all of them at once and exits with code 1. A token shorter
than 32 characters only logs a `WARNING`.

## Time zone

"Today" and every default date range use one zone. The server picks it in
this order:

1. `TZ`, when it names a zone other than exactly `UTC`.
2. The athlete's `timezone` in intervals.icu, read once at startup from
   `GET /athlete/{id}` (the `INTERVALS_ATHLETE_ID` athlete).
3. The process zone, which is UTC in the image.

`TZ` unset, blank or exactly `UTC` means "not chosen". `docker-compose.yml`
sets `TZ=UTC` when you set nothing, so by default the server follows the
athlete. To pin UTC, set `TZ=Etc/UTC`.

Startup waits up to 5 seconds for the lookup. After that, the server listens
with the fallback zone, and a late answer still applies. A transient failure
(a 429, a Cloudflare challenge, a timeout, a 5xx or a network fault) runs the
lookup again after 1, 5 and 15 minutes, then hourly. A Cloudflare challenge
is a 403 that never reached intervals.icu, so it counts as transient. A
refusal (any other 4xx, such as a revoked key or a wrong athlete id) keeps
the fallback and logs one `WARNING`. So does an
athlete with no zone set, or a zone the server does not recognise. Set `TZ` to
skip the lookup.

The server reads the zone once per process. After you change your time zone
in intervals.icu, restart the server. The startup log names the zone and its
source, for example `time zone Australia/Sydney (intervals.icu)`, and so does
`/health` (`time_zone`, `time_zone_source`).

## intervals.icu API key

Get your key from intervals.icu: Settings, Developer Settings. Set it as
`INTERVALS_API_KEY`. intervals.icu authenticates this key with HTTP Basic
auth using the literal username `API_KEY`.

Every tool call and every MCP App data fetch uses this key: `dispatchToolCall`
resolves it once per call via `getIntervalsApiKey()` and passes it to the
handler, which sends it as the Basic auth password on every intervals.icu
request. `/health` reports whether it is set (`api_key_configured`); it does
not check the key against intervals.icu.

The key grants full read/write access on the account it belongs to, with no
scoping. Keep `MCP_AUTH_TOKEN` set whenever the server is reachable from
outside localhost, so a stranger who finds the URL cannot use your key.

## Health check

`GET /health` reports server state without spending an intervals.icu API
request: served entirely from local state, safe to poll. The container's
`HEALTHCHECK` uses it.

Unauthenticated callers get liveness only:

```json
{ "status": "ok", "version": "<release>", "uptime_seconds": 5 }
```

With `MCP_AUTH_TOKEN` (`Authorization: Bearer <token>` or `?token=<token>`),
or on any server with no secret configured, it also reports config and
rate-limit state:

```json
{
  "status": "ok",
  "version": "<release>",
  "uptime_seconds": 5,
  "api_key_configured": true,
  "athlete_id": "0",
  "time_zone": "Australia/Sydney",
  "time_zone_source": "intervals.icu",
  "rate_limit": null,
  "tools": {
    "list-activities": {
      "calls": 3,
      "errors": 0,
      "total_ms": 1260,
      "last_called_at": "2026-10-05T01:02:03.000Z",
      "mean_ms": 420
    }
  }
}
```

`version` is `SERVER_VERSION`, resolved from the root `package.json` that
release-please bumps, so it tracks the release you are running. An `:edge` or
`:main-<sha>` image runs unreleased code and still reports the last release.
`time_zone` is the zone local dates use. `time_zone_source` says where it came
from: `env` (`TZ`), `intervals.icu` (the athlete's setting) or `fallback` (the
process zone); see [Time zone](#time-zone).
`rate_limit` is a snapshot parsed from the most recent intervals.icu response's
`X-RateLimit-*`/`Retry-After` headers (`intervalsApi.getRateLimitSnapshot()`);
intervals.icu sends none of these today (verified 2026-09-24), so `rate_limit`
stays `null` even after calls have been made, not just before the first one.
`tools` holds per-tool counters since the process started, busiest first.
Wiring monitoring: point an uptime check at the unauthenticated shape; send
the secret only when you want the config and quota detail.

## Per-call log line

Every tool call writes one JSON line to stderr (`docker compose logs -f`),
shown wrapped here:

```json
{
  "event": "tool_call",
  "tool": "view-training-load",
  "duration_ms": 420,
  "outcome": "ok",
  "rate_limit": null,
  "client_apps": true,
  "client_name": "claude-ai"
}
```

`outcome` is `ok`, `error`, `not_connected` or `invalid_args`; `error_class`
appears when a call threw. `client_apps` is true when the request's client
capabilities advertised MCP Apps (`io.modelcontextprotocol/ui` with
`text/html;profile=mcp-app`), and `client_name` is the `clientInfo.name` the
client sent, when it sent one. They exist to confirm which hosts advertise MCP
Apps before the `view-*` tools are hidden from clients that do not. For
example, `grep '"event":"tool_call"' | grep '"client_apps":false'` lists the
calls from hosts that would lose them.

## Securing the endpoint

A tunnel makes `/mcp` reachable by anyone who discovers the URL — including
the `update-activity` write tool and the intervals.icu API key configured on
the server. Set `MCP_AUTH_TOKEN` to a long random secret
(`openssl rand -hex 32`); the server then requires
`Authorization: Bearer <token>` on every `/mcp` request, returning 401
otherwise. Without it the endpoint stays open and the server logs a startup
warning when `PUBLIC_URL` is configured.

Set it in `.env` (`docker-compose.yml` forwards it automatically), or pass it
through yourself when running the published image without that compose file
(`docker run -e MCP_AUTH_TOKEN=...`).

Every served `/mcp` POST carries `Mcp-Method` (and, for a tool call,
`Mcp-Name` with the tool name), and the server rejects any request whose
headers disagree with its body. So a reverse proxy or WAF in front of the
server can log, rate-limit, or block by tool without parsing JSON — for
example, deny `Mcp-Name: update-activity` to make the instance read-only.
Only 2026-07-28 clients are served: a 2025-era client gets HTTP 400 with
JSON-RPC error `-32022` naming `2026-07-28` as the supported revision.

The secret also gates the detailed half of `/health` (open it with
`?token=<MCP_AUTH_TOKEN>` in a browser), so a stranger cannot read your
athlete id or quota state.

## Rate limits and resilience

The HTTP layer handles rate limits centrally: passive, nothing to configure
(see [architecture.md](architecture.md#request-pacing) and
[architecture.md](architecture.md#response-cache) for the implementation):

- intervals.icu sends no `X-RateLimit-*` or `Retry-After` headers (verified
  2026-09-24). Draft limits (go-live unconfirmed): 5,000 requests/day and
  2,500 per rolling 15 minutes per API key, about 10/s per IP. With no
  headers to react to, the client spaces requests 200ms apart instead
  (`intervalsApi`'s `minIntervalMs`), which stays well under that ceiling.
- If a response ever does carry `X-RateLimit-*`/`Retry-After` headers, the
  client still parses and honours them: a rate-limit response gets bounded
  retries respecting `Retry-After`, and a genuinely exhausted limit surfaces
  as a structured message naming which window is gone and when it resets.
- Transient `5xx` (including Cloudflare's `520`-`524`), network faults, and
  timeouts retry with bounded exponential backoff; only idempotent reads are
  retried, never writes. A timeout while the response body is still arriving
  counts the same as one before it.
- intervals.icu sits behind Cloudflare. When Cloudflare answers with an HTML
  error page, the tool error quotes only the page title, not the page. When
  it answers with a challenge (`cf-mitigated: challenge`, usually a 403), the
  tool error says so instead of blaming the API key: the request never
  reached intervals.icu. A challenge that keeps happening points at the
  server's outbound IP address or its `User-Agent`, not at the key.

Read `rate_limit` from [`/health`](#health-check) to see where you stand — it
reports the snapshot from the most recent intervals.icu response's headers,
which is `null` today since intervals.icu sends none.

## Docker notes

The image is distroless and runs as non-root **UID 65534**. There is no
persistent state to mount: credentials come from `INTERVALS_API_KEY` on every
start.

The image's `HEALTHCHECK` reads `PORT`, so a non-default port stays healthy:
`docker run -e PORT=8080 -p 8080:8080 …`. `docker-compose.yml` pins
`PORT=3000`. If you change it there, change the `ports` mapping to match.

On `docker stop` (SIGTERM), the server stops accepting connections and gives
calls already running up to 8 seconds to finish, then aborts the rest and
exits. `docker-compose.yml` sets `stop_grace_period: 10s` so Docker waits
longer than that before it sends SIGKILL; if you run the image some other
way, give it at least 10 seconds too (Docker's default). A second signal,
such as a second Ctrl-C, exits at once.

### Verifying a pulled image

Each published image carries a BuildKit SBOM and SLSA provenance in its index,
plus a Sigstore-backed provenance attestation bound to the release workflow's
identity:

```bash
# Signed provenance — proves which workflow and commit built this image
gh attestation verify oci://ghcr.io/ljcl/intervals-mcp:latest --repo ljcl/intervals-mcp

# What is inside it
docker buildx imagetools inspect ghcr.io/ljcl/intervals-mcp:latest --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/ljcl/intervals-mcp:latest --format '{{ json .Provenance }}'
```

The SBOM feeds vulnerability scanners directly (Trivy, Grype, Docker Scout).
See [releasing.md](releasing.md) for how these attestations are produced.

## Troubleshooting

Symptom index lives in the [README](../README.md#troubleshooting); each entry
links back into the section here that explains the mechanism. Kept in one place
so a fix does not have to land twice.
