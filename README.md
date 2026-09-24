# Strava MCP

[![CI](https://github.com/ljcl/strava-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ljcl/strava-mcp/actions/workflows/ci.yml)
[![Storybook](https://img.shields.io/badge/Storybook-live-ff4785?logo=storybook&logoColor=white)](https://ljcl.github.io/strava-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A Model Context Protocol (MCP) server that supplements the official Strava MCP connector. It adds write access, segments, routes, photos, derived analysis, and interactive visualizations that the official connector does not provide.

## Features

- Write and update activities (title, description, sport type, gear, flags)
- Create manual activities for sessions with no device recording (strength, yoga, treadmill)
- Explore, view, star, and manage segments
- Fetch per-activity photos, zone breakdowns, and running summaries
- List and view details of saved routes
- Export routes (GPX/TCX) and activity tracks (GPX built from streams)
- Derived analysis Strava does not expose: interval detection, climb/descent breakdown, aerobic decoupling, training load, fitness/fatigue/form (CTL/ATL/TSB), and a solved taper to a target race-day form
- AI-friendly JSON responses via MCP
- Nine interactive visualizations rendered in MCP-compatible hosts — activity chart, cadence trends, route map, activity segments, training load, compare activities, activity zones, segment progress, and fitness trend
- Guided prompts for weekly reviews, annotating a run, and segment hunting ([docs/tools.md](docs/tools.md#prompts))
- Automatic token refresh
- Streamable HTTP transport for remote deployment

Browse the UI components in the [live Storybook](https://ljcl.github.io/strava-mcp/).

The full tool catalog, prompts, permission behaviour, and example requests live in [docs/tools.md](docs/tools.md).

## Quick Start (Docker)

### 1. Get an intervals.icu API Key

1. Log in to [intervals.icu](https://intervals.icu)
2. Go to Settings, Developer Settings
3. Copy your personal API key

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
INTERVALS_API_KEY=your_api_key
```

All variables are listed in [docs/operations.md](docs/operations.md#environment-variables). Prefer the prebuilt image? Pull `ghcr.io/ljcl/strava-mcp:latest` (also on the [MCP registry](https://registry.modelcontextprotocol.io) as `io.github.ljcl/strava-mcp`) and point your compose `image:` at it instead of building; you still supply your own API key. Published images carry SBOM/provenance attestations you can verify — see [operations.md](docs/operations.md#verifying-a-pulled-image).

### 3. Start the Server

```bash
docker compose up -d
```

`GET /health` reports liveness without spending an intervals.icu API request; with `MCP_AUTH_TOKEN` it also reports config and rate-limit state. Response shapes and monitoring guidance: [operations.md](docs/operations.md#health-check).

### 4. Connect to Claude Desktop

Add to your Claude configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "strava": {
      "type": "url",
      "url": "https://your-public-url/mcp",
      "headers": { "Authorization": "Bearer your-mcp-auth-token" }
    }
  }
}
```

The `headers` entry is only needed when `MCP_AUTH_TOKEN` is set (recommended for tunnel-exposed servers — see [Securing the endpoint](#securing-the-endpoint)).

Restart Claude Desktop to load the new configuration.

## Connecting to AI Tools

Most AI tools (Claude Desktop, Claude Code, etc.) need an HTTPS URL to reach your MCP server. Since the server runs on your local network, you'll need a tunnel to expose it.

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

A tunnel makes `/mcp` reachable by anyone who discovers the URL — including the `update-activity` write tool and the intervals.icu API key configured on the server. Set `MCP_AUTH_TOKEN` to a long random secret (`openssl rand -hex 32`) and every `/mcp` request requires `Authorization: Bearer <token>`; each client snippet below shows where the header goes. The secret also gates the detailed half of `/health`. Full details: [operations.md](docs/operations.md#securing-the-endpoint).

Set it in `.env` alongside your API key — `docker-compose.yml` forwards it automatically.

```text
AI Tool (Claude Desktop, Claude Code, etc.)
    │  HTTPS
HTTPS Tunnel (Tailscale / Cloudflare)
    │  HTTP (localhost:3000)
Strava MCP Server (Docker / Bun)
    │  HTTPS
Strava API
```

### Client configuration

The server works with any MCP client that supports the Streamable HTTP transport. In every snippet below, replace `https://your-public-url` with your tunnel URL (or `http://localhost:3000` for local development), and include the `Authorization` header only if you set `MCP_AUTH_TOKEN`.

#### Claude Code

```bash
claude mcp add --transport http strava https://your-public-url/mcp \
  --header "Authorization: Bearer your-mcp-auth-token"
```

#### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "strava": {
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
    "strava": {
      "type": "http",
      "url": "https://your-public-url/mcp",
      "headers": { "Authorization": "Bearer your-mcp-auth-token" }
    }
  }
}
```

#### Other clients (generic Streamable HTTP)

Any client that speaks [Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports) can connect to the `/mcp` endpoint directly. One URL serves both protocol eras: 2026-07-28 clients send stateless requests carrying the `io.modelcontextprotocol/*` envelope keys (`server/discover` advertises capabilities); 2025-era clients use the ordinary `initialize` handshake. POST JSON-RPC messages with an `Accept: application/json, text/event-stream` header. Protocol details: [docs/architecture.md](docs/architecture.md#runtime-and-transport).

## Using alongside the official Strava MCP

Strava's official MCP connector handles activity discovery and basic reads. This server supplements it with everything the official connector does not offer: writing to activities, segments, routes and GPX/TCX export, photos, derived analysis, and interactive visualizations.

### Install both

- Official: `claude mcp add --transport http strava-mcp https://mcp.strava.com/mcp` (or via claude.ai Connectors / Claude Desktop).
- This server: see the install steps above.

### Who does what

| Capability | Official | This server |
| ---------- | -------- | ----------- |
| List / read activities, streams, profile, zones, gear, clubs, training plan | yes | no (use official) |
| Update activities, star segments | no | yes |
| Segment detail / search / efforts | no | yes |
| Routes plus GPX/TCX export | no | yes |
| Activity GPX export (synthesized from streams) | no | yes |
| Activity photos | no | yes |
| Athlete stats, per-activity zones, best efforts, running summary, training load, compare | no | yes |
| Interval, hill, and aerobic analysis; fitness/fatigue/form (CTL/ATL/TSB) | no | yes |
| Interactive apps: activity chart, cadence trends, route map, activity segments, training load, compare activities, activity zones, segment progress, fitness trend | no | yes |

### Caveats

- The official connector requires a Strava subscription and currently runs only in Anthropic clients.
- With the duplicate reads removed, this server now effectively assumes the official connector is installed for activity discovery. The aggregate analysis tools (`get-best-efforts`, `get-training-load`) fetch their own activity lists, but per-activity tools (`get-running-summary`, `compare-activities`, `get-activity-zones`, etc.) need an activity id from the official `list_activities`.
- The two use separate rate-limit quotas, so running both spreads API load.

### Recommended workflow

Use the official connector to discover and read activities, then use this server to write, explore segments, manage and export routes, and visualize. The model can pass activity ids from official `list_activities` directly into this server's tools.

## Example requests

Ask your AI assistant questions like these (use the official Strava MCP to discover activity IDs, then pass them to these tools):

- "Update the title of activity 12345678 to 'Morning Threshold'"
- "Show me the HR zone breakdown for activity 12345678"
- "Break down the intervals in activity 12345678 — did I fade across the reps?"
- "Did I positive-split Sunday's long run, or was that just the hills?"
- "My race is on 13 September — what should the next three weeks look like so I arrive at TSB +10?"
- "Am I getting faster on segment 8109834? Show my effort history"
- "Map my race route with fuel stops at 10k, 21k, and 32k, and flag the climb at 28k"

More in [docs/tools.md](docs/tools.md#example-requests).

## Local Development

Prerequisites: [Bun](https://bun.sh/) and an intervals.icu account.

```bash
bun install
cp .env.example .env   # add your INTERVALS_API_KEY

# Start dev server (server + MCP App watchers)
bun run dev
```

Then point any client at `http://localhost:3000/mcp`. Repo layout, task runner, tests, coverage gates, and Storybook workflow: [docs/development.md](docs/development.md). Agent conventions live in [AGENTS.md](AGENTS.md).

## Documentation

| Doc | Contents |
| --- | -------- |
| [docs/tools.md](docs/tools.md) | Full tool catalog, prompts, permission behaviour, example requests |
| [docs/operations.md](docs/operations.md) | Environment variables, auth/token handling, health endpoint, rate limits, endpoint security |
| [docs/architecture.md](docs/architecture.md) | Server architecture: transport, HTTP layer, cache, error taxonomy, analysis math |
| [docs/mcp-apps.md](docs/mcp-apps.md) | MCP App packages: shared shell, mobile, theming, per-app details |
| [docs/development.md](docs/development.md) | Monorepo mechanics: Turborepo, coverage gates, Storybook gates, Docker build |
| [docs/releasing.md](docs/releasing.md) | Release automation: Conventional Commit PR titles, release-please, publishing |
| [docs/project.md](docs/project.md) | Issue tracking and project board |

PRs are squash-merged and the **PR title becomes the commit on `main`**, so write it as a [Conventional Commit](https://www.conventionalcommits.org/) (`feat:` minor, `fix:` patch, `feat!:` major; `chore:`/`docs:`/`refactor:`/`ci:` release nothing). A CI check rejects non-conforming titles; see [docs/releasing.md](docs/releasing.md).

## Troubleshooting

**AI tool can't reach the server** — MCP requires an HTTPS URL. Use a tunnel (Tailscale Funnel or Cloudflare Tunnel) to expose your local server. See [Connecting to AI Tools](#connecting-to-ai-tools).

**API key errors** — Check `/health` first: `api_key_configured` tells you whether the server has a key set at all. If it is `true` but calls still fail, the key may be wrong or revoked — generate a new one at intervals.icu, Settings, Developer Settings, and update `INTERVALS_API_KEY`. See [operations.md](docs/operations.md#intervalsicu-api-key).

**Is the server up and reachable?** — `curl https://your-public-url/health`. It answers without touching the intervals.icu API, so it works even when your rate limit is exhausted.

**Client re-prompts for read tools after I granted them** — A release likely renamed a tool or changed its input schema; grants are stored per tool identity, so that drops the grant. Releases say so in the changelog. Otherwise persistence lives in the client — check both connector-level and per-tool settings. See [docs/tools.md](docs/tools.md#tool-permissions).

## License

MIT
