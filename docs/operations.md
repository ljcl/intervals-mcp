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
| `ROUTE_EXPORT_PATH` | No | Absolute path for saving exported GPX files. Unset, the export tools return the document inline instead |

## intervals.icu API key

Get your key from intervals.icu: Settings, Developer Settings. Set it as
`INTERVALS_API_KEY`. The server sends it as HTTP Basic auth with the literal
username `API_KEY`.

The key grants full read/write access on the account it belongs to — there is
no scoping. Keep `MCP_AUTH_TOKEN` set whenever the server is reachable from
outside localhost, so a stranger who finds the URL cannot use your key.

## Health check

`GET /health` reports server state without spending a Strava API request —
served entirely from local state, safe to poll. The container's `HEALTHCHECK`
uses it.

Unauthenticated callers get liveness only:

```json
{ "status": "ok", "version": "<release>", "uptime_seconds": 5 }
```

With `MCP_AUTH_TOKEN` (`Authorization: Bearer <token>` or `?token=<token>`) —
or on any server with no secret configured — it also reports config and
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
release-please bumps, so it tracks the release you are running. `rate_limit` is
a snapshot from the most recent Strava response, so it stays `null` until the
server has made one. Wiring monitoring: point an uptime check at the
unauthenticated shape; send the secret only when you want the config and quota
detail.

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

The secret also gates the detailed half of `/health` (open it with
`?token=<MCP_AUTH_TOKEN>` in a browser), so a stranger cannot read your
athlete id or quota state.

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

The image is distroless and runs as non-root **UID 65534**. There is no
persistent state to mount: credentials come from `INTERVALS_API_KEY` on every
start. `docker-compose.yml` mounts a named `exports` volume at `/app/exports`
for `ROUTE_EXPORT_PATH`, which is optional.

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
