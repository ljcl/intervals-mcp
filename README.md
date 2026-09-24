# Intervals Extra (intervals-mcp)

[![CI](https://github.com/ljcl/intervals-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ljcl/intervals-mcp/actions/workflows/ci.yml)
[![Storybook](https://img.shields.io/badge/Storybook-live-ff4785?logo=storybook&logoColor=white)](https://ljcl.github.io/intervals-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A single-user remote MCP server for intervals.icu run data and analysis, with interactive MCP Apps. Continues from [strava-mcp](https://github.com/ljcl/strava-mcp).

> **Migration in progress.** The server is being ported from Strava to
> intervals.icu (Phases 1 and 2). Sixteen tools now talk to intervals.icu
> directly and are verified against a real account; see
> [docs/tools.md](docs/tools.md) for the full catalog. `get-training-load`,
> `get-fitness-trend`, `update-activity`, and the Phase 4 `view-*`/
> `get-*-data` app tools still call the retired Strava client and fail with
> a "not yet ported" error until each is moved over in a later phase. The
> presence of `INTERVALS_API_KEY` is checked at startup and reported on
> `/health`.

## Setup

### 1. Get an intervals.icu API key

1. Log in to [intervals.icu](https://intervals.icu)
2. Go to Settings, Developer Settings
3. Copy your personal API key

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
INTERVALS_API_KEY=your_api_key
```

All variables are listed in [docs/operations.md](docs/operations.md#environment-variables).

### 3. Run it

Local development (needs [Bun](https://bun.sh/)):

```bash
bun install
bun run dev
```

Docker:

```bash
docker compose up -d
```

Prefer the prebuilt image? Pull `ghcr.io/ljcl/intervals-mcp:latest` (also on
the [MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.ljcl/intervals-mcp`) and point your compose `image:` at it instead
of building; you still supply your own API key. Published images carry
SBOM/provenance attestations you can verify; see
[operations.md](docs/operations.md#verifying-a-pulled-image).

`GET /health` reports liveness without spending an intervals.icu API request;
with `MCP_AUTH_TOKEN` it also reports config and rate-limit state. Response
shapes and monitoring guidance: [operations.md](docs/operations.md#health-check).

Point any client at `http://localhost:3000/mcp`. Repo layout, task runner,
tests, coverage gates, and Storybook workflow: [docs/development.md](docs/development.md).
Agent conventions live in [AGENTS.md](AGENTS.md).

## Connecting to AI Tools

Most AI tools (Claude Desktop, Claude Code, etc.) need an HTTPS URL to reach
your MCP server. Since the server runs on your local network, you'll need a
tunnel to expose it.

### Tailscale Funnel (Recommended)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes a local port to the internet over HTTPS with no configuration:

```bash
tailscale funnel --bg 3000
# → https://your-machine.tail1234.ts.net
```

Set `PUBLIC_URL` in your `.env` to the resulting URL.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3000
```

### Securing the endpoint

A tunnel makes `/mcp` reachable by anyone who discovers the URL, so they can
use the intervals.icu API key configured on the server (the key itself is
never exposed to them). Set `MCP_AUTH_TOKEN` to a
long random secret (`openssl rand -hex 32`) and every `/mcp` request requires
`Authorization: Bearer <token>`; each client snippet below shows where the
header goes. The secret also gates the detailed half of `/health`. Full
details: [operations.md](docs/operations.md#securing-the-endpoint).

Set it in `.env` alongside your API key; `docker-compose.yml` forwards it
automatically.

```text
AI Tool (Claude Desktop, Claude Code, etc.)
    │  HTTPS
HTTPS Tunnel (Tailscale / Cloudflare)
    │  HTTP (localhost:3000)
intervals-mcp Server (Docker / Bun)
    │  HTTPS
intervals.icu API
```

### Client configuration

The server works with any MCP client that supports the Streamable HTTP
transport. In every snippet below, replace `https://your-public-url` with
your tunnel URL (or `http://localhost:3000` for local development), and
include the `Authorization` header only if you set `MCP_AUTH_TOKEN`.

#### Claude Desktop

Add to your Claude configuration
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "intervals-mcp": {
      "type": "url",
      "url": "https://your-public-url/mcp",
      "headers": { "Authorization": "Bearer your-mcp-auth-token" }
    }
  }
}
```

Restart Claude Desktop to load the new configuration.

#### Claude Code

```bash
claude mcp add --transport http intervals-mcp https://your-public-url/mcp \
  --header "Authorization: Bearer your-mcp-auth-token"
```

#### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "intervals-mcp": {
      "url": "https://your-public-url/mcp",
      "headers": { "Authorization": "Bearer your-mcp-auth-token" }
    }
  }
}
```

#### VS Code

Add to `.vscode/mcp.json` in your workspace (or run **MCP: Add Server** from the command palette):

```json
{
  "servers": {
    "intervals-mcp": {
      "type": "http",
      "url": "https://your-public-url/mcp",
      "headers": { "Authorization": "Bearer your-mcp-auth-token" }
    }
  }
}
```

#### Other clients (generic Streamable HTTP)

Any client that speaks [Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports) can connect to the `/mcp` endpoint directly. One URL serves both protocol eras: 2026-07-28 clients send stateless requests carrying the `io.modelcontextprotocol/*` envelope keys (`server/discover` advertises capabilities); 2025-era clients use the ordinary `initialize` handshake. POST JSON-RPC messages with an `Accept: application/json, text/event-stream` header. Protocol details: [docs/architecture.md](docs/architecture.md#runtime-and-transport).

## Tools

The full tool catalog, prompts, permission behaviour, and example requests
live in [docs/tools.md](docs/tools.md). Sixteen tools talk to intervals.icu
directly; `get-training-load`, `get-fitness-trend`, `update-activity`, and
the Phase 4 app tools still call the transitional Strava client and return a
"not yet ported" error until a later phase.

## Documentation

| Doc | Contents |
| --- | -------- |
| [docs/tools.md](docs/tools.md) | Full tool catalog, prompts, permission behaviour, example requests |
| [docs/operations.md](docs/operations.md) | Environment variables, the API key, health endpoint, rate limits, endpoint security |
| [docs/architecture.md](docs/architecture.md) | Server architecture: transport, HTTP layer, cache, error taxonomy, analysis math |
| [docs/api-notes.md](docs/api-notes.md) | Calling the intervals.icu API: auth, endpoints, verified behaviour from Phases 1 and 2 |
| [docs/mcp-apps.md](docs/mcp-apps.md) | MCP App packages: shared shell, mobile, theming, per-app details |
| [docs/development.md](docs/development.md) | Monorepo mechanics: Turborepo, coverage gates, Storybook gates, Docker build |
| [docs/releasing.md](docs/releasing.md) | Release automation: Conventional Commit PR titles, release-please, publishing |
| [docs/project.md](docs/project.md) | Issue tracking and project board |

PRs are squash-merged and the **PR title becomes the commit on `main`**, so write it as a [Conventional Commit](https://www.conventionalcommits.org/) (`feat:` minor, `fix:` patch, `feat!:` minor pre-1.0, major once the package reaches 1.0.0; `chore:`/`docs:`/`refactor:`/`ci:` release nothing). A CI check rejects non-conforming titles; see [docs/releasing.md](docs/releasing.md).

## Troubleshooting

**AI tool can't reach the server** — MCP requires an HTTPS URL. Use a tunnel (Tailscale Funnel or Cloudflare Tunnel) to expose your local server. See [Connecting to AI Tools](#connecting-to-ai-tools).

**API key errors:** Check `/health` first: `api_key_configured` tells you whether the server has a key set at all. For a tool already ported to intervals.icu, if `api_key_configured` is `true` but calls still fail, the key may be wrong or revoked; generate a new one at intervals.icu, Settings, Developer Settings, and update `INTERVALS_API_KEY`. A tool not yet ported (see [docs/tools.md](docs/tools.md)) fails with a "not yet ported" message regardless of the key. See [operations.md](docs/operations.md#intervalsicu-api-key).

**Is the server up and reachable?** `curl https://your-public-url/health`. It answers without touching the intervals.icu API, so it works even when your rate limit is exhausted.

**Client re-prompts for read tools after I granted them** — A release likely renamed a tool or changed its input schema; grants are stored per tool identity, so that drops the grant. Releases say so in the changelog. Otherwise persistence lives in the client — check both connector-level and per-tool settings. See [docs/tools.md](docs/tools.md#tool-permissions).

## License

MIT
