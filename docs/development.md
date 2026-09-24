# Development

Working in the monorepo: layout, task running, tests, coverage gates,
Storybook, and the Docker image contract. Day-to-day commands live in
[AGENTS.md](../AGENTS.md#commands); release mechanics live in
[releasing.md](releasing.md).

## Project structure

```
apps/server/                 MCP server (tools, HTTP transport, config)
apps/storybook/              Storybook for UI development
packages/activity-chart/     Interactive activity chart (MCP App)
packages/cadence-trends/     Cadence trend analysis (MCP App)
packages/route-map/          Activity GPS map (MCP App)
packages/training-load/      Weekly training volume and trend (MCP App)
packages/compare-activities/ Two-activity stream overlay (MCP App)
packages/activity-zones/     Per-activity time-in-zone chart (MCP App)
packages/fitness-trend/      Fitness/fatigue/form chart with taper plan (MCP App)
packages/data/               Shared pure data utilities
packages/ui/                 Shared presentational React components + app shell runtime
packages/design-system/      Design tokens, color constants, Storybook preview
packages/vite-config/        Shared Vite config for MCP App builds
packages/tsconfig/           Shared TypeScript configurations
```

Bun workspaces with Turborepo. A `topo` transit node in `turbo.json` keeps
`test` and `typecheck` cache-correct when upstream JIT packages change source.
JIT packages (`data`, `ui`, `design-system`) export raw TypeScript; only the
seven MCP App packages produce build artifacts (single-file HTML via Vite). The
server has no build step. Biome (`//#lint`) and Knip (`//#knip`) run as root
tasks — Knip is a whole-graph analyzer that cannot decompose per-package; Biome
is fast enough to run at root per Turborepo docs.

**Do NOT change root `lint` to `turbo run lint`** (infinite loop). Biome runs
directly via root `lint`; turbo dispatches it only through `bun run check` or
`turbo run lint`. In CI, `ci.yml` runs Biome as a dedicated step
(`bun run lint --reporter=github`, not through turbo) so diagnostics surface as
inline PR annotations — turbo's task-name prefix breaks that parsing.

`biome.json` sets `linter.rules.nursery.preset: "recommended"`, and **that
grants no rules** on the pinned Biome (2.5.8) — nursery coverage is zero,
however the key reads. Verified in-repo: `setTimeout("doSomething()", 100)`
passes `biome check` silently yet `biome lint --only=lint/nursery/noImpliedEval`
flags it, and the identical preset mechanism on a stable group does fire. The
key stays because it starts working if Biome later makes presets grant nursery
rules; a nursery rule is enforced here only if something names it explicitly.

### Package boundaries

Enforced via `turbo boundaries`; six tags: `app`, `mcp-app`, `shared-ui`,
`shared-data`, `design-system`, `config`. Key rules: apps cannot cross-import,
mcp-apps cannot cross-import, `data` is pure (no React), `design-system` sits at
the bottom.

Because mcp-apps cannot import each other, anything two apps need has exactly
one home in `packages/data` or `packages/ui` — never a copy. Neither knip nor
Biome can see a genuinely-imported duplicate; the only defence is not making it.

## Verification sweep

Run before declaring a task complete, opening a PR, or cutting a release. Each
step is a hard requirement.

```bash
bun run check             # Lint + test + typecheck + build + boundaries (cached)
bun run check:affected    # Same, only packages changed since main
bun run test:stories      # Every story renders in headless Chromium (needs Playwright browsers)
docker compose build      # Server container builds from current sources
```

Individual steps if needed:

```bash
bun run typecheck         # TS across every workspace package
bun run lint              # Biome (root task, not per-package)
bun run test              # Vitest (server + any package with tests)
bun run build             # Produces MCP App single-file HTML bundles
bun run boundaries        # Package boundary enforcement
bun run knip              # Dead code / unused export analysis
bun run test:coverage     # Tests with coverage (per-package coverage/ output)
bun run coverage:summary  # Aggregate coverage into one markdown table
```

Supplementary when the change touches UI:

- Storybook sweep: look at each affected story in desktop and the
  `claudeIosCard` mobile viewport (`bun run shots <story-id>…` renders PNGs).
- MCP endpoint smoke test: `cd apps/server && bun run start`, then
  `curl http://localhost:3000/health`. Needs a valid `INTERVALS_API_KEY`;
  skip if it is not configured and say so explicitly.

## Coverage thresholds

`apps/server`, `packages/data`, `packages/design-system`, and `packages/ui`
set `coverage.thresholds` in their vitest.config.ts, and each `test:coverage`
run **auto-ratchets** them: vitest rewrites the numbers to a fixed cushion under
measured coverage (5 points for server and ui, 2 for the ~100% packages), so
the floor rises as coverage grows and a genuine drop fails CI.

If a coverage run dirties a vitest.config.ts, that's the ratchet — commit it,
never hand-edit the numbers.

The view-heavy packages are intentionally unthresholded per package; their
component floor is the story render-path report
(`vitest.stories.config.ts`, own auto-ratchet, 5-point cushion) — same rule:
commit the rewrite, don't hand-edit. `packages/ui` is hybrid: its coverage
`include` lists only hooks/stores/helpers no story reaches (`useServerToolData`,
`useServerToolFetcher`, `keyedFetchStore`, `useModelContextSync`,
`useMobileMode`, `serverToolResult`, `standardSchema`), while components stay
with the render-path report. "No story reaches it" is the entry test, not "it
is logic": `viewTools.ts` is logic and deliberately out, because stories already
floor it. Listing a module in both reports drags the aggregate — and therefore
the ratchet — down over the hooks the floor guards. Those hooks are tested via
the small `renderHook` harness in `src/renderHook.ts` (happy-dom environment);
the repo has no React testing library and needs none.

CI's check job runs specs once, in the `test:coverage` step — `test` is absent
from the `turbo run` line on purpose (adding it doubles every spec), and that
step is deliberately not `--affected` (turbo restores cached `coverage/**` for
unchanged packages, keeping every row of the summary table populated). Only
jobs that run turbo tasks take the `.turbo` cache, and the key is namespaced
`<os>-turbo-<workflow>-<job>-<sha>` — otherwise an early-finishing job reserves
the key and later jobs cannot save, or same-SHA jobs collide.

## Clearing a `bun audit` failure

`ci.yml`'s `audit` job is advisory on PRs and main pushes and a **hard gate on
the weekly schedule**. Findings are almost always transitive, and `bun update`
will not touch them: it only moves within package.json ranges (every direct dep
is exact-pinned for Dependabot), while the lockfile keeps serving whatever
transitive versions resolved months ago. Re-resolve fully:

```bash
rm -f bun.lock && bun install    # re-resolve every transitive dep
bun audit --audit-level=high     # expect no output
```

That is a lockfile-only diff, but it re-races hoisting across the whole graph —
run the entire verification sweep after it (`test:stories` especially, the only
gate rendering the apps in a real browser). Check the diff for **downgrades and
dropped packages**, not just bumps: the winner of the re-race is whichever
constraint is hard, not whichever version is right. `overrides` in root
package.json pins the cases where the race picks wrong (currently
`react-is: 19.2.8` — hoisting can satisfy recharts' peer with
pretty-format@27's `^17.0.1`, whose brand-check misses React 19 elements and
silently stops fragment flattening).

## Storybook

Storybook (`apps/storybook`) renders the UI packages. The `main` build publishes
to GitHub Pages (`storybook.yml`); there is no per-PR hosted build, so review a
branch's UI by checking it out and running `bun run storybook`.

A running dev server also exposes an MCP endpoint (`@storybook/addon-mcp`) with
story, docs, and test tools, pre-wired in `.mcp.json` as `storybook` at
`http://localhost:6006/mcp`. The GitHub Pages build is static and has no
endpoint.

The automated UI gate: every story renders in real headless Chromium as a
Vitest browser-mode smoke test and passes axe accessibility, on every PR and
main push. Behaviour lives in stories' `play` functions.

**No pixel-level visual-regression gate exists, on purpose.** Chromatic was
removed once its free snapshot budget ran out; render + a11y + interaction
coverage stayed. Vitest 4 browser mode ships `toMatchScreenshot` if
self-hosted visual regression is ever wanted, but it needs a pinned render
environment and committed baselines, which we chose not to maintain.
`scripts/story-shots.ts` (`bun run shots`) is the look-at-it tool, not a gate:
it renders stories to PNGs in gitignored `story-shots/`, catching what DOM
assertions structurally cannot — a smoothed line implying data between points,
a clipped axis label, a chart that renders perfectly and says the wrong thing.

```bash
bun run shots --list                              # story ids from the build index
bun run shots training-load-app--default          # PNG per story id
bun run shots --width 380 <id>                    # mobile width (pair with the Mobile story)
bun run shots --dark <id>                         # backgrounds.value:dark
bun run shots --hover "svg.recharts-surface" <id> # capture a chart tooltip
bun run shots --url http://localhost:6006 <id>    # shoot a running dev server, skip the build
```

It builds `storybook-static` once and reuses it; `--rebuild` refreshes.
`--hover-at x,y` aims within the hovered element; `--wait` extends settle time
for slow-mounting charts.

### Story smoke tests

Root `vitest.stories.config.ts` (deliberately not `vitest.config.ts` — vitest
searches parent directories, so a default-named root config would hijack every
package's bare `vitest run`) defines one `storybook` project via
`@storybook/addon-vitest`'s `storybookTest` plugin, rendering each story in
headless Chromium. All stories use CSF factories, so no vitest setup file is
needed. Config caveats:

- The addon pins project root to `apps/storybook` but resolves co-located story
  globs against `test.dir` — the project's `test.dir` must stay at repo root or
  no story files are found.
- Coverage needs `coverage.allowExternal: true`, or every `packages/*` file is
  "external" and the report is empty.
- Browser resolution: `resolveChromiumExecutablePath()` returns `undefined`
  (no-op) whenever Playwright's pinned build is installed — local and CI. It
  resolves to a path only in sandboxes shipping a different pre-installed
  Chromium and blocking downloads; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
  overrides everything.
- CI caches Playwright browsers keyed on the pinned playwright version plus
  runner image; a miss installs with `--with-deps`, a hit runs only
  `install-deps` — the apt-get half is never cached and must run either way.
- Plain `bun run test:stories` stays coverage-free; `test:stories:coverage`
  adds v8 render-path coverage over every `packages/*` source the stories
  execute (#197's report, gated by the ratchet above).

### Autodocs

`@storybook/addon-docs` generates a Docs page per component from stories,
JSDoc, and react-docgen props. Placement is load-bearing: project tags on the
shared design-system preview do **not** reach the docs indexer when that preview
is re-exported, so `apps/storybook/.storybook/preview.tsx` re-exports it as
default **and** declares `export const tags = ["autodocs"]` (named preview
exports merge with the default). Write docs by writing good stories: JSDoc
above a `component` or story becomes Docs prose; opt noisy interaction-only
stories out with `tags: ["!autodocs"]`.

### Per-story axe checks

`@storybook/addon-a11y` runs axe on every story — panel in dev, and inside the
story smoke tests in CI (preview annotations composed into the design-system
`definePreview`). Global default is `parameters.a11y.test: "error"` repo-wide,
so a violation fails the build wherever it appears; do not reintroduce a
per-file `a11y` parameter to route around a violation.

What the sweep that made this repo-wide actually found: all violations were
`color-contrast`, none structural. Three conventions keep the checks honest:

- The design-system preview decorator paints `--color-background-primary` on
  the theme wrapper (axe otherwise measures dark-mode text against the white
  test canvas).
- Hidden/faded `Legend` labels keep contrast-passing text (only the swatch
  dims) because enabled toggles must stay readable.
- `--color-text-tertiary` is decoration, never an element's only label — at
  12px it falls under 4.5:1 in some host palettes.

Theme-invariant tier backgrounds pair with the invariant foreground
(`--color-tier-text`), not `--color-text-inverse` (correct in dark, white-on-
amber in light).

## Docker image build

Built via `turbo prune @intervals-mcp/server --docker`; the builder stage uses
`--filter=@intervals-mcp/server^...` to build only the server's workspace deps
(the MCP App packages), excluding the JIT server itself. The prune stage
derives the package set from the workspace graph — no edit per package needed
there.

The distroless **runner** stage `COPY`s each app's `dist/` explicitly, and
covers **JIT dependencies too**: `@intervals-mcp/data` exports raw TypeScript with
no build output, so the runner copies `packages/data/src`. That per-package
COPY list is the image's one manual step — adding an MCP App means adding one
`COPY --from=builder .../packages/<app>/dist` line there.

Missing a COPY is invisible until the container starts: `bun install` still
writes the workspace symlink and prune still supplies the manifest, so
resolution walks to a file that is not in the image and the process dies on
first import. No image build catches it, which is why
`apps/server/src/dockerRuntime.test.ts` resolves every `@intervals-mcp/*`
specifier in the server's non-test sources through the target package's
`exports` map and asserts the file lands inside a runner COPY — in both
directions (a stale COPY for a removed app fails too), pinning that destinations
mirror source paths (bun resolves against `/app` as repo root) and that the
entry point a specifier resolves to is covered. It models only `--from=builder`
copies as content, and it is sound only while COPYs are directories — narrowing
one to a single file outruns the test.
