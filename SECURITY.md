# Security Policy

intervals-mcp is a single-user MCP server: it holds an intervals.icu API key
supplied by its operator. Vulnerabilities in that surface are worth reporting
privately.

## Supported versions

Only the latest release receives security fixes. Older tags and the
corresponding `ghcr.io/ljcl/intervals-mcp` images are not patched: upgrade to
the newest version before reporting an issue you can only reproduce on an old
one.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Preferred: [report a vulnerability privately via GitHub](https://github.com/ljcl/intervals-mcp/security/advisories/new)
  (Security tab → "Report a vulnerability").
- Fallback: email <luke@lukeclark.com.au> with "intervals-mcp security" in the
  subject.

Include what you can: affected version or image tag, reproduction steps, and
impact. You can expect an acknowledgement within 7 days and a fix or a
mitigation plan within 30 days for confirmed issues. This is a spare-time
project, so those are targets rather than guarantees.

## Scope

In scope:

- The MCP server (`apps/server`): config and startup, `/mcp` transport, tool
  handlers that call the Strava API.
- The published Docker image (`ghcr.io/ljcl/intervals-mcp`).
- The MCP App bundles served as resources (`ui://.../app.html`).

Out of scope:

- The Strava API itself — report Strava platform issues to Strava.
- Vulnerabilities that require an already-compromised host or a
  misconfigured deployment (for example, exposing the server publicly without
  the documented reverse proxy / tunnel).
- Denial of service via upstream rate limits.

## Secret handling

- The intervals.icu API key is supplied via an environment variable only; it
  is never written to disk by the server.
- The container runs as the non-root user UID 65534 on a distroless base (see
  [docs/operations.md](docs/operations.md#docker-notes)).

If you find the API key or other secrets leaking anywhere outside the
environment (logs, error messages, MCP tool output), that is a
vulnerability, please report it.
