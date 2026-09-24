# Operations

Running and operating a deployed instance: configuration, auth flows, health,
tokens, rate limits, and endpoint security. For the code behind these see
[architecture.md](architecture.md).

## Environment variables

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `STRAVA_CLIENT_ID` | Yes | Strava Application Client ID |
| `STRAVA_CLIENT_SECRET` | Yes | Strava Application Client Secret |
| `PUBLIC_URL` | Yes* | Public URL for OAuth callback (required for web auth) |
| `STRAVA_ACCESS_TOKEN` | No | Initial access token (from `bun run setup-auth`) |
| `STRAVA_REFRESH_TOKEN` | No | Initial refresh token (from `bun run setup-auth`) |
| `MCP_AUTH_TOKEN` | No | Shared secret; when set, `/mcp` requires `Authorization: Bearer <token>`, and `/auth/start`, `/auth/status`, and the authed half of `/health` require it too (header or `?token=`) |
| `ROUTE_EXPORT_PATH` | No | Absolute path for saving exported files. Unset, the export tools return the document inline instead |
| `TOKEN_DATA_DIR` | No | Override token storage directory (default: `./data`) |
| `PORT` | No | Server port (default: `3000`) |

\* Required for Docker/web-based OAuth; not needed with local `bun run setup-auth`.

## Authorization

Web/Docker flow: create a Strava API application
([strava.com/settings/api](https://www.strava.com/settings/api)) with the
"Authorization Callback Domain" set to your public hostname, then visit
`https://your-public-url/auth/start`. Tokens save automatically. Check status
at `/auth/status`. If `MCP_AUTH_TOKEN` is set, append `?token=<MCP_AUTH_TOKEN>`
to both URLs.

Local development flow:

```bash
cd apps/server && bun run setup-auth   # guided OAuth using localhost as redirect URI
```

**Token handling** is automatic: validity checked on startup, refreshed on 401s
during operation, persisted to `data/tokens.json` (survives container
restarts). You authorize once **per scope set** — the refresh token obtains new
access tokens but cannot add scopes that were not granted originally. When a
release adds a tool needing a new scope (e.g. `activity:write`), re-authorize:
local via `setup-auth`, web via `/auth/start`. Both use `approval_prompt=force`
so Strava re-prompts and issues a token carrying the current scope set.
Re-authorize anytime at `/auth/start` if a refresh token was revoked.

## Health check

`GET /health` reports server state without spending a Strava API request —
served entirely from local state, safe to poll. The container's `HEALTHCHECK`
uses it.

Unauthenticated callers get liveness only:

```json
{ "status": "ok", "version": "<release>", "uptime_seconds": 5 }
```

With `MCP_AUTH_TOKEN` (`Authorization: Bearer <token>` or `?token=<token>`) —
or on any server with no secret configured — it also reports auth and rate-limit state:

```json
{
  "status": "ok",
  "version": "<release>",
  "uptime_seconds": 5,
  "authenticated": false,
  "token_expires_at": null,
  "rate_limit": null
}
```

`version` is `SERVER_VERSION`, resolved from the root `package.json` that
release-please bumps, so it tracks the release you are running. `rate_limit` is
a snapshot from the most recent Strava response, so it stays `null` until the
server has made one. Wiring monitoring: point an uptime check at the
unauthenticated shape; send the secret only when you want token and quota
detail.

`authenticated` and `token_expires_at` describe the token set the running
server actually uses: the in-memory copy that refreshes rotate and both OAuth
exchanges write. Once that copy exists a poll costs no disk read and adds no
`Loaded tokens` lines to the logs, so polling `/health` (or `/auth/status`,
which reports the same state) does not bury real telemetry in
`docker compose logs`. The trade-off: a `tokens.json` replaced by hand
underneath a running process is not picked up until restart, exactly as tool
calls do not pick it up, so restart the server after replacing the file by
hand. An unauthenticated server keeps checking the file on every poll, so a
fresh authorization shows up on the next one.

## Securing the endpoint

A tunnel makes `/mcp` reachable by anyone who discovers the URL — including
the `update-activity` write tool. Set `MCP_AUTH_TOKEN` to a long random secret
(`openssl rand -hex 32`); the server then requires
`Authorization: Bearer <token>` on every `/mcp` request, returning 401
otherwise. Without it the endpoint stays open and the server logs a startup
warning when `PUBLIC_URL` is configured.

Set it in `.env` (`docker-compose.yml` forwards it automatically), or pass it
through yourself when running the published image without that compose file
(`docker run -e MCP_AUTH_TOKEN=...`).

The secret also gates the OAuth web routes: `/auth/start` and `/auth/status`
require it (in a browser, open `/auth/start?token=<MCP_AUTH_TOKEN>`), so a
stranger cannot start an authorization flow against your server or read your
athlete id and token expiry. `/auth/callback` stays open for Strava's redirect
but only accepts callbacks carrying the single-use `state` nonce minted by
your own `/auth/start`, so it cannot overwrite your stored tokens with someone
else's account.

## Rate limits and resilience

The HTTP layer handles Strava's limits centrally — passive, nothing to
configure:

- Every response's `X-RateLimit-*` / `X-ReadRateLimit-*` (15-minute and daily
  windows) and `Retry-After` headers are parsed. Strava allows 100
  requests/15 min and 1000/day by default
  ([docs](https://developers.strava.com/docs/rate-limits/)).
- On a rate-limit response the client honours `Retry-After` and retries
  (bounded). When the limit is genuinely exhausted the model gets a structured
  message naming which window is gone and when it resets.
- Transient `5xx` and network faults retry with bounded exponential backoff;
  only idempotent reads are retried, never writes.

Read `rate_limit` from [`/health`](#health-check) to see where you stand — it
reports the snapshot from the most recent Strava response without spending a
request.

## Docker notes

The image is distroless and runs as non-root **UID 65534**. Tokens persist to
the host-mounted `./data`, which must be writable by that UID or token
persistence fails on first run:

```bash
mkdir -p data
sudo chown -R 65534:65534 data
```

Alternatively swap the bind mount for a named volume in `docker-compose.yml`
(e.g. `strava-data:/app/data`); Docker initializes named volumes with correct
ownership.

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
