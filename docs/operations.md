# Operations

Running and operating a deployed instance: configuration, the API key, health,
rate limits, and endpoint security. For the code behind these see
[architecture.md](architecture.md).

## Environment variables

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `INTERVALS_API_KEY` | Yes | intervals.icu personal API key (Settings, Developer Settings) |
| `INTERVALS_ATHLETE_ID` | No | Athlete id; default `0` means the API key's own athlete |
| `TZ` | No | IANA time zone for local dates, e.g. `Australia/Sydney` |
| `MCP_AUTH_TOKEN` | No | Shared secret; when set, `/mcp` and the detailed half of `/health` require `Authorization: Bearer <token>` (or `?token=` for `/health`) |
| `PORT` | No | Server port (default: `3000`) |
| `PUBLIC_URL` | No | Public URL, used only to warn when `/mcp` is exposed without `MCP_AUTH_TOKEN` |

## intervals.icu API key

Get your key from intervals.icu: Settings, Developer Settings. Set it as
`INTERVALS_API_KEY`. intervals.icu authenticates this key with HTTP Basic
auth using the literal username `API_KEY`.

Every tool call and every MCP App data fetch uses this key: `dispatchToolCall`
resolves it once per call via `getIntervalsApiKey()` and passes it to the
handler, which sends it as the Basic auth password on every intervals.icu
request. `/health` also validates and reports on it (`api_key_configured`).

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
  "rate_limit": null
}
```

`version` is `SERVER_VERSION`, resolved from the root `package.json` that
release-please bumps, so it tracks the release you are running. `rate_limit`
is a snapshot parsed from the most recent intervals.icu response's
`X-RateLimit-*`/`Retry-After` headers (`intervalsApi.getRateLimitSnapshot()`);
intervals.icu sends none of these today (verified 2026-09-24), so `rate_limit`
stays `null` even after calls have been made, not just before the first one.
Wiring monitoring: point an uptime check at the unauthenticated shape; send
the secret only when you want the config and quota detail.

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
- Transient `5xx` and network faults retry with bounded exponential backoff;
  only idempotent reads are retried, never writes.

Read `rate_limit` from [`/health`](#health-check) to see where you stand — it
reports the snapshot from the most recent intervals.icu response's headers,
which is `null` today since intervals.icu sends none.

## Docker notes

The image is distroless and runs as non-root **UID 65534**. There is no
persistent state to mount: credentials come from `INTERVALS_API_KEY` on every
start.

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
