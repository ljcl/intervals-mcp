# Backlog and issue tracking

Improvements and changes are tracked as GitHub Issues and triaged on the
"intervals-mcp backlog" Project board (https://github.com/users/ljcl/projects/3).

- File issues via the templates (Improvement, Bug report); blank issues are
  allowed.
- Labels: `type:*` mirrors Conventional Commit types (feat, fix, perf,
  refactor, docs, test, chore, ci); `area:*` maps to monorepo packages (server,
  mcp-app, data, ui, design-system, ci-release, docker, repo). Bot and
  community labels (dependencies, autorelease:*, good first issue) are managed
  automatically.
- Priority (P1/P2/P3), Effort (S/M/L), and Status live as Project board fields,
  not labels, so triage data is not duplicated across two systems.
- New issues auto-add to the board (Backlog). Link PRs with `closes #N` so a
  merge closes the issue; the PR title is the Conventional Commit that
  release-please turns into a release (see [releasing.md](releasing.md)).
- After an epic, breaking change, or wide refactor merges, run the
  `backlog-sweep` skill: big changes invalidate file/line references,
  dependency notes, and premises in open issues, and a sweep fixes that drift
  while it is still cheap.

## Editing the project board

Board fields (Status, Priority, Effort) are writable by agents. Two paths, by
session type:

**Local sessions** — `gh project` commands; the authenticated gh token has
`project` scope:

```bash
gh project item-edit --project-id PVT_kwHOABzAhM4Bkfpa --id <item-id> \
  --field-id <field-id> --single-select-option-id <option-id>
```

Discover item/field/option ids with
`gh project item-list 3 --owner ljcl --format json` and
`gh project field-list 3 --owner ljcl --format json`.

**Cloud and iOS sessions** (no gh, no project scope on the built-in GitHub
credential) — the hosted GitHub MCP server with `GH_MCP_PAT`. The
`github-projects` entry in `.mcp.json` is the working configuration: base
`https://api.githubcopilot.com/mcp/` plus an `X-MCP-Toolsets: projects,issues`
header, which serves `projects_list` / `projects_get` / `projects_write`
alongside the issue tools and none of the PR/actions ones. The path-scoped
`/mcp/x/projects` endpoint serves the same projects trio
(`/x/projects/readonly` for the read-only pair) if a session needs projects
without issues. Watch for: the base endpoint initializes fine whatever the
header says, so a toolset that failed to load does not announce itself — check
the advertised tool names, not the handshake. Issue filing and edits go through
the ordinary issue tools (`issue_read`, `list_issues`, `search_issues`,
`issue_write`); before any edit that resends a body, see
[Reading issue bodies](#reading-issue-bodies-before-rewriting-them) below.

If the `github-projects` entry is not connected, drive the endpoint directly
over JSON-RPC with curl: POST `initialize`, capture the `Mcp-Session-Id`
**response header**, POST the `notifications/initialized` notification, then
POST `tools/call`. Every later request must carry that session header.
Responses come back as SSE, so parse the `data:` line rather than the whole
body. A CONNECT-level 403 to `api.githubcopilot.com` is not necessarily a
standing policy denial — the proxy reports "policy denial **or** upstream
failure" for both, so retry once before concluding the host is blocked.

Hosted-build notes: `field_names` **is** deployed — pass
`["Status","Priority","Effort"]` to `list_project_items` / `get_project_item`
instead of numeric ids. `projects_write.update_project_item` takes one field
per call via `updated_field`, accepts the by-name shape
(`{"name":"Priority","value":"P1"}` — option *name*, not option id), and
resolves the target from `item_owner` + `item_repo` + `issue_number`, so item
ids are no longer needed. Ids stay discoverable via `list_project_fields`.

### Board constants

Project number 3, owner `ljcl`.

| Field | Field id |
| ----- | -------- |
| Status | PVTSSF_lAHOABzAhM4BkfpazhjQC3o |
| Priority | PVTSSF_lAHOABzAhM4BkfpazhjQC4Y |
| Effort | PVTSSF_lAHOABzAhM4BkfpazhjQC4c |

| Status option | id |
| ------------- | -- |
| Backlog | f75ad846 |
| Ready | a057814c |
| In progress | 47fc9ee4 |
| In review | 2ba31d84 |
| Done | 98236657 |

| Priority option | id |
| --------------- | -- |
| P1 | fc38b480 |
| P2 | d2ef2472 |
| P3 | 5197fbf4 |

| Effort option | id |
| ------------- | -- |
| S | ed6278ac |
| M | c5c30106 |
| L | 7270adf2 |

## Reading issue bodies before rewriting them

Every hosted-MCP read path (`issue_read`, `list_issues`, `search_issues`)
returns issue bodies through the same sanitizer. It strips anything shaped
like an HTML tag, and it can cut the body off at the first such token,
including one inside inline backticks. Two observed cases: `Promise<string>`
comes back as `Promise`, and the 2026-09-02 sweep saw #351 truncated
mid-sentence by both `issue_read` and `search_issues` while the web page
showed the complete text (three acceptance criteria). No read tool is exempt.

Round-tripping a body read that way silently destroys content, and reading it
back afterwards does not catch it: both sides pass through the same sanitizer,
so a damaged body compares equal to itself.

Before any `issue_write` that resends a body (appending a triage footer,
editing an approach section, any update), fetch the rendered issue page
(WebFetch on the issue's `html_url`, or the browser) and compare it with the
API copy. If the API copy is shorter, or the page holds any angle-bracketed
text the API copy lacks, do not rewrite: leave a comment carrying the change
instead, the way the 2026-09-02 sweep did on #351.

When filing or editing issues, put HTML-shaped payloads in fenced code blocks
rather than inline backticks. The sanitizer's exact behaviour on fenced blocks
is unverified, so the page comparison above is still the check that protects
the body.
