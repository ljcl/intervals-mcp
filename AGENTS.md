# intervals-mcp

Remote MCP server connecting AI tools to intervals.icu run data.

## Documentation

Reference docs live in `docs/`. Read the relevant one before working in its area;
this file holds only the invariants that apply to every change.

| Doc | Read before |
| --- | ----------- |
| [docs/architecture.md](docs/architecture.md) | Changing server internals (transport, HTTP layer, cache, errors, analysis math, tool metadata) |
| [docs/mcp-apps.md](docs/mcp-apps.md) | Adding or changing an MCP App package, `packages/ui`, or `packages/data` |
| [docs/tools.md](docs/tools.md) | Adding, renaming, or describing tools/prompts — it is the single catalog; keep it current |
| [docs/api-notes.md](docs/api-notes.md) | Calling the intervals.icu API; record verified behaviour here |
| [docs/operations.md](docs/operations.md) | Configuring or debugging a deployed instance |
| [docs/development.md](docs/development.md) | Turborepo, coverage gates, Storybook gates, Docker image build |
| [docs/releasing.md](docs/releasing.md) | Shipping — PR titles are Conventional Commits; release automation does the rest |
| [docs/project.md](docs/project.md) | Filing/triaging issues, editing the project board |
| [docs/Intervals_MCP_Server.md](docs/Intervals_MCP_Server.md) | Capability reference to upload as project knowledge in a Claude project using this server |

## Architecture invariants

One line each; full rationale in docs/architecture.md. These exist because
breaking them has shipped bugs — do not work around them locally.

- **Only the 2026-07-28 revision is served.** `mcpEndpoint.ts` serves it
  statelessly per request with `legacy: "reject"`: a 2025-era request gets
  HTTP 400 `-32022` naming the supported revision. Do not reintroduce a legacy
  fallback — a claim-less request skips the `Mcp-Method`/`Mcp-Name` header
  check, so it would bypass any proxy rule keyed on those headers. No sessions
  (`Mcp-Session-Id` is gone; GET/DELETE answer 405). The endpoint parses every POST body itself with
  `parseJsonWithLargeInts` → SDK `parsedBody`; that seam keeps 64-bit ids
  intact.
- **Rate limits and retries live in `fetchClient.ts`, never per-tool.**
  Parses `X-RateLimit-*`/`Retry-After` into a snapshot; bounded retries honour
  `Retry-After`; transient 5xx/network faults retry GET/HEAD only, never
  writes.
- **Error types survive translation.** `handleApiError` rethrows
  `RateLimitError` intact (context prefixed onto `message`, bare window detail
  kept) and wraps everything else in `IntervalsApiError extends HttpError`
  (`intervalsClient.ts`), so `tools/_errors.ts` can branch on the type or
  status without string-matching. Flattening to plain `Error` silently kills
  callers' `instanceof`/status checks; degrade only on a type or status that
  is still there.
- **Caching policy lives in `intervalsCacheTtl`** (`fetchClient.ts`;
  path-keyed TTLs; key is full URL, TTL matches query-stripped path). Writes
  invalidate descendants AND ancestors; `skipCache: true` guards append
  reads. intervals.icu sends no rate-limit headers, so its client
  (`intervalsApi`) paces itself instead: `minIntervalMs` enforces a minimum
  gap between the start of consecutive request attempts, across concurrent
  callers, rather than reacting to a response after the fact.
- **Intervals stream reads go through `loadIntervalsStreams` in
  `intervalsStreams.ts`**; only a genuine 404 or empty result throws
  `IntervalsStreamsUnavailableError`, the one error a caller may degrade on.
- **Derived numbers have exactly one home.** GAP: `hillAnalysis.ts`
  (`gapFactor`, `computeGrades`); `splitAnalysis.ts` imports, never
  re-derives. CTL/ATL/TSB and any projection/taper math: `fitnessTrend.ts`.
  Step-cadence spm and averaged running dynamics: `activityCadenceSpm`/
  `buildRunningDynamics` in `utils/running.ts` (shared by `get-activity` and
  `compare-activities`). Lap text rendering: `formatLapLine` in
  `intervalLaps.ts` (shared by `get-activity-laps` and `get-running-summary`).
  Running efficiency factor (m/min per beat): `speedEfficiencyFactor` in
  `aerobicAnalysis.ts` (shared by `get-aerobic-analysis` and
  `compare-activities`). Text tool and app reading different copies is the
  failure mode these prevent.
- **Telemetry:** `dispatchToolCall` emits one JSON line per call; timer starts
  before token resolution (not-connected calls count); a returned `isError`
  counts as an error; `recordToolCall` can never fail the call it describes.
- **Progress:** every handler gets a `ReportProgress` closure (third arg,
  always present). Tick counter without `total` (spec demands monotonic
  increase; multi-phase calls can't carry two denominators); time-based
  throttle with `important: true` bypass; fire-and-forget.
- **The API key comes from `getIntervalsApiKey()`** (`config.ts`), passed to
  handlers as argument 2; never read `process.env.INTERVALS_API_KEY`
  elsewhere. A missing key maps to one not-configured message naming the env
  var.
- **All reads and writes go through `intervalsClient.ts`.** The retired
  Strava client has been deleted; do not add a new provider-specific client.
- **Ids go through `intervalsActivityIdInput`** (accepts an optional `i`
  prefix, e.g. `i189807578`), in `tools/_ids.ts`. Advertised schema is
  string-only (`idJsonSchemaOverride`) because ids above 2^53 are rounded by
  hosts' `JSON.parse` unrecoverably; safe-int numbers accepted at runtime,
  normalised to digit strings; handlers pass strings through without parsing
  back.
- **Tools returning data publish `outputSchema` + matching
  `structuredContent`** from `tools/outputs.ts` (schemas grouped, not per
  file). Text tools reuse the apps' mappers rather than re-deriving, e.g.
  `get-activity-zones` calls `mapIntervalsZones` from `activityZones.ts`. Empty
  results emit a valid payload (`count: 0`). `warnOnSchemaDrift` keeps dev
  honest.
- **`update-activity` never claims success or silently fails on an
  ambiguous write.** It reads the activity fresh, then validates `gearId`
  against a `skipCache: true` `list-gear` read, in that order, so a missing
  activity reports not-found before any gear error. If the PUT itself times
  out, or anything fails after it resolved (the confirming re-read,
  parsing), it cannot tell whether the write landed, so it says so and
  points at `get-activity` rather than inviting a blind retry.
- **Annotations come from the four `_annotations.ts` constants**, never inline
  objects — they decide whether hosts grant reads durably or re-prompt forever.
  `READ_ONLY` states `destructiveHint: false` explicitly (its documented
  default is `true`). Nothing may set `_meta["anthropic/requiresUserInteraction"]`.
  `server.annotations.test.ts` holds an exhaustive read/write classification
  table — a new tool must be added to it.
- **Tool identity is a published contract.**
  `tool-surface.lock.json` fingerprints `name + annotations + inputSchema +
  outputSchema + _meta`; `toolSurface.test.ts` fails on drift. Regenerate
  deliberately (`UPDATE_TOOL_SURFACE_LOCK=1 bunx vitest run
  src/toolSurface.test.ts`) and say so in the PR — users pay a round of
  re-prompting.
- **Protocol-surface tests go over the wire**
  (`server.integration.test.ts` via `mcpTestClient.ts`): capabilities, object inputSchemas (no `$ref`), string
  ids, `structuredContent`, `isError` not JSON-RPC errors, app resources,
  prompts. Extend the shared client, never a new bootstrap copy.
- **Tool error text has one home: `toolErrorText` (`tools/_errors.ts`).** It
  branches on `RateLimitError` / `HttpError.status` (404, 402, 401/403),
  never on message text; every `isError` text starts with `❌`. Imports come
  from `fetchClient.ts` only (tool tests mock the client module with bare
  factories, so an import from there would be `undefined` under those
  mocks). Catch blocks and the dispatcher's final catch call it for the
  text and write the `{ content, isError: true }` literal themselves. Tests
  reject with the `__fixtures__/errors.ts` shapes (`handledRateLimit`,
  `handledNotFound`, `handledSubscriptionRequired`), never a plain
  `Error("404 Not Found")`.
- **The response cache never shares references and coalesces in-flight
  GETs.** Every value `FetchClient` hands out (hit, populating miss, coalesced
  awaiter) is a `structuredClone`; concurrent identical cacheable GETs share
  one upstream promise (failures never cached, write invalidation drops
  in-flight entries, `skipCache` bypasses both). Never return a cached object
  by reference or add a per-tool in-flight map.
- **The Bun version has one home: root `packageManager`.** CI reads it via
  `bun-version-file`; `dockerRuntime.test.ts` pins the Dockerfile's
  `FROM oven/bun:<tag>` lines to the same x.y.z, because Dependabot bumps the
  base image but never `packageManager`, and the lockfile must be resolved and
  installed by the same Bun. The same test pins `.tool-versions` (mise/asdf)
  so a local install cannot resolve the lockfile with a stale Bun.

## Key Directories

- `apps/server/`: MCP server (tools, HTTP transport, config)
- `apps/storybook/` — Storybook host rendering the UI packages (co-located stories)
- `packages/activity-chart/` — React + Recharts MCP App for interactive activity charts
- `packages/cadence-trends/` — React + Recharts MCP App for cadence trend analysis
- `packages/training-load/` — React + Recharts MCP App for weekly training volume with trend line and injury-risk warnings
- `packages/route-map/` — React MCP App for activity GPS maps (MapLibre basemap by default, pure-SVG offline grid fallback; no Recharts)
- `packages/compare-activities/` — React + Recharts MCP App overlaying two activities' streams with a delta summary
- `packages/activity-zones/`: React + Recharts MCP App for per-activity HR time-in-zone distribution (power zones dropped for now; see docs/api-notes.md)
- `packages/fitness-trend/` — React + Recharts MCP App charting CTL/ATL/TSB with warning bands and a dashed taper plan
- `packages/data/` — Shared pure data utilities (formatting, activity types, smoothing). Formatters live here, once (`formatting.ts`): MCP App packages cannot import each other, so a formatter two apps need has exactly one home; duplicated copies are invisible to knip and Biome. Server-side equivalent: `apps/server/src/formatters.ts`; sport-specific transforms in `utils/running.ts`
- `packages/ui/` — Shared presentational React components (Pill, Tooltip, Legend, SummaryBar, AppShell, CardHeader, EmptyState, ErrorState, LoadingState, Skeleton) plus the app-shell runtime (`AppRoot`, `useServerToolData`, `useServerToolFetcher`, `useModelContextSync`, `useMobileMode`)
- `packages/design-system/` — Shared design tokens, color constants, and Storybook preview
- `packages/vite-config/` — Shared Vite config for MCP App single-file builds
- `packages/tsconfig/` — Shared TypeScript configurations
- `docs/` — Reference documentation ([index](docs/README.md))

## Agent Skills

Project-scoped Agent Skills are vendored under `.agents/skills/` and surfaced to Claude Code via
symlinks in `.claude/skills/`. Externally-sourced skills are tracked in `skills-lock.json` (source
+ content hash); locally-authored skills are not locked.

- `mcp-authoring` — locally-authored, framework-neutral guidance for building and reviewing MCP
  servers and apps (primitives, tool schema design, MCP App UI, OAuth, testing). Use it when
  changing server tools, resources, or the MCP App packages.
- `backlog-sweep` — locally-authored procedure for re-verifying open GitHub issues against the
  current code and fixing drift. Run it after an epic, breaking change, or wide refactor merges,
  or before planning a batch of backlog work.
- `bun` — Bun runtime, package manager, test runner, and bundler usage (well-known source).
- `github-actions-docs` — docs-grounded help for the workflows under `.github/` (GitHub source).

## Styling

- Use CSS Modules (`*.module.css`) for all React component styling — no inline `style={}` for static styles
- Use `data-*` attributes for state-driven variants (e.g. `data-active`, `data-hidden`)
- Keep inline `style` only for truly dynamic values computed at runtime (e.g. per-entry colors from props)
- Recharts component props (`stroke`, `fill`, `strokeWidth`, etc.) are library API and stay as props
- Design tokens come from `packages/design-system` via CSS custom properties (`var(--color-*)`, `var(--font-*)`)
- Spacing: use `var(--space-*)` tokens (`--space-0-5` through `--space-6`, a 4px grid with half-steps) instead of hardcoded px
- Border radius: full-rounded elements use `var(--border-radius-full)`
- Line heights outside the default 1.5: use `var(--line-height-tight)` or `var(--line-height-relaxed)`
- Uppercase label letter spacing: `var(--letter-spacing-wide)`
- Shared Recharts numeric tokens live in `packages/design-system/src/chart-tokens.ts`. Use `getChartTokens(mode)` in any new chart view; per-chart layout margins stay local
- `MOBILE_BREAKPOINT_PX` lives in design-system and is re-exported from `packages/ui`

### Headless primitives (Base UI)

[Base UI](https://base-ui.com/) (`@base-ui/react`, pinned in `packages/ui`) is the headless
primitive of record for any non-trivial interactive control — anything that needs focus
management, positioning, dismissal, or roving tabindex (Select, Menu, Dialog, Popover, Combobox,
Slider, ToggleGroup, etc.). Reach for it before hand-rolling these. Keep all styling in CSS Modules
with `data-*` selectors (Base UI exposes `data-pressed`, `data-disabled`, etc.; you can also keep
passing your own `data-*` where the existing selectors expect them). Use `@base-ui/react`, not the
frozen `@base-ui-components/react`.

Not every component needs a primitive. `Tooltip` (rendered inside Recharts' tooltip, which owns
positioning), `Skeleton`, and `AppShell` are presentational and stay hand-rolled.

Chart accessibility: every Recharts chart sets `accessibilityLayer` (keyboard focus + arrow-key
tooltip stepping) plus `title`/`desc` props rendered as SVG `<title>`/`<desc>`, with narration
built by a unit-tested `a11y.ts` in each MCP App package; this convention owns the
interactive-control migration.

## MCP App essentials

The complete shell/mobile/theming/view-tool guide plus per-app details:
[docs/mcp-apps.md](docs/mcp-apps.md) — read it before adding or substantially changing an app.
Non-negotiables:

- Every app's `main.tsx` is `AppRoot`'s four-branch state machine (connect error → unusable input
  → waiting for input → content) from `packages/ui`; pre-content states render inside the same
  `AppShell` so card chrome is stable from first paint.
- An app with a required id declares `missingArgsMessage`; omitting it strands the app on a
  permanent skeleton calling the server with `id: undefined`.
- Mount fetch: `useServerToolData`. Keyed/on-demand fetches: `useServerToolFetcher` — never a
  hand-rolled effect, never a "cached or in flight" guard (a failed fetch satisfies neither, so
  the effect refetches forever).
- Every app opens with `CardHeader`; no-data renders `EmptyState` (test what the chart actually
  needs, not just row count); layout comes from `mode` via `getChartTokens(mode)`.
- Mobile detection: `useMobileMode(hostCtx)` only. Bias toward mobile — false positives are
  cosmetic, false negatives make charts unreadable.
- New app checklist: an `"./app.html": "./dist/app.html"` entry in the package's `exports`
  (the server resolves resources through it at runtime and throws without one), one
  `APP_RESOURCES` table entry in `server.ts` (drives both resource descriptor and content
  `_meta.ui`), one runner `COPY` line in the Dockerfile (`dockerRuntime.test.ts` enforces
  coverage in both directions), stories with desktop + `claudeIosCard` variants.

## Commands

```bash
bun install               # Install all deps (workspace-aware)
bun run check             # Full verification: lint + test + typecheck + build + boundaries
bun run check:affected    # Same, but only packages changed since main
bun run build             # Build all packages (via Turborepo)
bun run build:affected    # Build only changed packages
bun run test              # Run all tests (via Turborepo)
bun run test:stories      # Run every Storybook story as a Vitest browser-mode smoke test
bun run test:stories:coverage # Same, plus render-path coverage into coverage-stories/
bun run test:coverage     # Tests with coverage (per-package coverage/ output)
bun run coverage:summary  # Aggregate coverage into one markdown table (CI job summary)
bun run shots --list      # List story ids; `bun run shots <id>…` screenshots them to story-shots/
bun run typecheck         # Typecheck all packages (via Turborepo)
bun run typecheck:affected # Typecheck only changed packages
bun run lint              # Lint all packages (Biome, root task)
bun run lint:fix          # Auto-fix lint issues
bun run knip              # Dead code / unused export analysis
bun run boundaries        # Package boundary enforcement
bun run dev               # Dev mode (via Turborepo)

# Server only
cd apps/server
bun run start        # Start server
bun run dev          # Watch mode
bun run test         # Run server tests (Vitest)
bun run test:watch   # Watch mode

# UI development
cd apps/storybook
bun run storybook    # Storybook on port 6006

# Single-file rebuilds
cd packages/<mcp-app>
INPUT=app.html bunx vite build

# Docker
docker compose build
docker compose up -d
docker compose logs -f
```

## Verification gate

Run before declaring a task complete, opening a PR, or cutting a release — each step is a hard
requirement (details: [docs/development.md](docs/development.md#verification-sweep)):

```bash
bun run check             # fastest local gate; prefer check:affected on a branch
bun run test:stories      # needs Playwright browsers
docker compose build      # when the change affects the container
```

Coverage ratchets auto-tighten: if `test:coverage` rewrites numbers in a vitest.config.ts, commit
that — never hand-edit the threshold values.

Turborepo caches all tasks; Biome and Knip run as root tasks (do NOT move root `lint` under turbo —
infinite loop). Package boundaries are enforced by `turbo boundaries`; CI runs on every PR.
