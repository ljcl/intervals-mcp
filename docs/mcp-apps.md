# MCP App packages

Conventions shared by the seven React MCP App packages
(`packages/{activity-chart,cadence-trends,route-map,training-load,compare-activities,activity-zones,fitness-trend}`),
then per-app details. Read this before adding or substantially changing an app.

## App shell conventions

Every app's `main.tsx` is the same four-branch state machine, so it lives in
`packages/ui` (`AppShell.tsx`) rather than in each app.

- **`AppRoot`** connects to the host and renders: connect error → unusable input
  → waiting for input → content. `children` is a render prop, so it only runs
  once `app` and `toolArgs` are non-null and the content component never
  re-checks them. Each pre-content state renders inside the same `AppShell` as
  the loaded app, so the card chrome is stable from first paint.
- **Host context updates are partial.** A `hostcontextchanged` notification
  carries only the fields that changed. The SDK merges it into
  `getHostContext()` before any listener runs. `useHostRoot` listens with
  `addEventListener` and reads that merged context each time. Do not store
  the notification itself as the context. Each field that it omits then
  becomes undefined: the fullscreen toggle disappears and the safe-area
  padding goes (#54).
- **An app with a required id declares `missingArgsMessage`.** `parseToolInput`
  returning `null` then means "the host spoke and the input is unusable" — an
  `ErrorState` naming the missing id, not an endless skeleton. Omit the message
  only when every argument is optional (cadence-trends, training-load,
  fitness-trend); omitting it on an app that needs an id puts that app on a
  permanent loading skeleton calling the server with `id: undefined`. The
  classification is pure and unit-tested (`classifyToolInput`); the branches
  are storied on `AppRootView`, since a live host is not reachable from
  Storybook.
- **Host arguments are the model's raw arguments.** The server accepts old
  spellings through its aliases, so `toolArgs` may say `activity_id`,
  `activity_id_1`/`activity_id_2` or `weeks`. Each app's `parseToolInput`
  normalises them first, to `id`, `activityId1`/`activityId2` and `days`
  (`days ?? weeks * 7`); nothing else reads the raw object, and the data
  feeds are called with the new names only. The id spellings have one home,
  `packages/ui/src/toolArgs.ts` (`ID_ARG_KEYS`, `ACTIVITY_ID1_ARG_KEYS`,
  `ACTIVITY_ID2_ARG_KEYS`, mirroring the server's `ALIAS_GROUPS` in
  `argAliases.ts`): single-activity apps use its `parseIdToolArgs`, and
  route-map, compare-activities and cadence-trends keep a small
  `src/toolArgs.ts` for their extra fields.
- **`"latest"` is pinned to the run the app first showed.** A view tool
  called with `id: "latest"` hands the app `toolArgs` holding the word, and
  its tool result names the run in `_meta["intervals-mcp/resolvedArgs"]`
  (`RESOLVED_ARGS_META_KEY`, declared in `apps/server/src/latestActivity.ts`
  and repeated in `packages/ui/src/latestPin.ts`). `useHostRoot` registers
  `ontoolresult` before connect and replaces each `"latest"` in `toolArgs`
  with the resolved id, so a view re-mounted later (the chat reopened) still
  shows that run rather than a newer one. Until the result arrives
  `pendingLatest` holds `AppRootView` on its waiting branch, so no app
  fetches the word moments before the pin lands; after `LATEST_PIN_WAIT_MS`
  (1,500 ms) with no result it lets go and the app fetches with `"latest"`,
  so a host that never sends tool results still gets a chart. If resolution
  takes longer than that wait, the app fetches with `"latest"` first and
  refetches once the pinned id arrives: one extra fetch, then the same run.
- **Fetching.** `useServerToolData` is the mount-time single fetch every app
  makes. Anything keyed and on-demand — a stream per selected run — goes
  through `useServerToolFetcher` instead of a hand-rolled effect. Its state
  machine is `KeyedFetchStore`, deliberately outside React so its two rules are
  directly testable: a key is fetched at most once, and only an explicit
  `retry` re-fires a failed one. Do not reintroduce a "cached or in flight"
  guard — a failure satisfies neither, so the effect refetches forever.
  Both hooks pass the same call options (`progressCallOptions`). The host
  restarts its request timeout on each progress notification, and the latest
  message is kept for `LoadingState` to show. The keyed fetcher keeps one
  message per key, on the entry's `progress`. Pick what to render from a
  key's own `loading` and `error`. Do not treat "no data yet" as loading: a
  failed key has no data either, so its error and retry stay hidden behind a
  skeleton.
- **Every app opens with a `CardHeader`.** In a host transcript the card is
  otherwise detached from the tool call that produced it. Subtitles are built
  by a unit-tested helper next to the app's other pure normalizers
  (`buildCadenceSubtitle` is the pattern).
- **No-data is `EmptyState`, never a bare chart frame.** Test what the chart
  actually needs, not just the row count: an activity whose only stream is time
  parses into points that plot nothing.
- **Layout comes from `mode`.** `getChartTokens(mode)` serves `chartAspect`
  along with the other numeric tokens; per-chart margins stay local.

Every app bundles as a single HTML file via `vite-plugin-singlefile`
(`INPUT=app.html bunx vite build`) and is served as an MCP resource
(`ui://<app>/app.html`). Apps call their `get-…-data` companion tool (app-only
visibility) on mount.

### Chart accessibility

Every Recharts chart sets `accessibilityLayer` (keyboard focus + arrow-key
tooltip stepping) plus `title`/`desc` props rendered as SVG `<title>`/`<desc>`,
with the narration built by a unit-tested `a11y.ts` in each package (mirroring
route-map's `a11yDescription.ts`). Host context sync goes through
`useModelContextSync` (`src/contextSummary.ts`), reporting the view state the
model should know about.

## Targeting mobile

Use `useMobileMode(hostCtx)` from `@intervals-mcp/ui`. Do not roll your own
detection. Five signals at a 640px breakpoint, any one triggers mobile:

1. `host.platform === "mobile"` (strongest, rarely populated)
2. `deviceCapabilities.touch && !deviceCapabilities.hover`
3. `containerDimensions.width` or `maxWidth` under the breakpoint
4. Live `window.innerWidth` via `useSyncExternalStore` (the reliable fallback
   on Claude iOS where the first three are empty)
5. UA sniff for iPhone, iPad, Android

640px covers iPhone Pro Max, rotated iPad split view, and narrow desktop side
panels. Bias toward mobile: false-positive mobile on desktop is cosmetic;
false-negative on mobile makes charts unreadable.

Mobile token patterns: views take a `mode: "mobile" | "desktop"` prop and
spread `getChartTokens(mode)` into their local tokens (axis font, stroke
widths, dot scale). Per-chart layout values stay local — narrower chart aspect,
tighter YAxis width, drop axis-label titles and dense overlays on mobile, hide
secondary controls that cost footer width, `Legend size="touch"` for tappable
vertical padding.

Storybook mobile previews use `globals: { viewport: { value: "claudeIosCard" } }`,
`parameters: { layout: "fullscreen" }`, and a `MobileCardShell` decorator —
what renders inside the host iframe, not Storybook's padded canvas.

## Card chrome and theming

MCP Apps own their outer chrome, not the host:

1. Server emits `_meta: { ui: { prefersBorder: false } }` on BOTH the resource
   descriptor AND the content response. Both derive from the `APP_RESOURCES`
   table in `server.ts` via `appResourceMeta`, so a new app is one table entry
   (per-app extras like route-map's `csp` go on the entry's `ui` field).
2. The app wraps content in a card with background, border, border-radius,
   responsive padding: mobile `{ y: 16, x: 14 }`, desktop `{ y: 24, x: 20 }`,
   each plus `safeAreaInsets.*` via `calc()`.
3. Mobile adds outer margin so Claude iOS (which gives the iframe zero
   surrounding padding) does not clip the card border at the iframe edge.
4. Fullscreen: `AppShell` owns the enter/exit toggle; it renders only when the
   app passes its connected `app` AND the host advertises `fullscreen` in
   `availableDisplayModes` — no dead button on hosts without the capability.
   After a request, the toggle shows the mode that `requestDisplayMode`
   returned. Some hosts grant a request and do not send new context, so this
   echo keeps the toggle correct. The next mode that the host reports
   replaces the echo.
5. Width constraint keeps children from forcing the card wider than the iframe:
   `boxSizing: "border-box"`, `width: calc(100% - ${outerMargin * 2}px)`,
   `overflow: hidden`. Without it a too-wide footer forces horizontal scroll
   plus a clipped header. Footer rows use `flex-wrap: wrap`.

Theming flows entirely from the host: `packages/design-system/src/tokens.css`
intentionally has no `@media (prefers-color-scheme: dark)` rule, because
host-injected vars fight partial overrides from a media query on `:root`. Dark
mode on Claude iOS comes from the host sending dark vars. Storybook simulates
dark via the `[data-theme="dark"]` selector on its decorator; a dark story
variant needs only `globals: darkGlobals` (from `@intervals-mcp/design-system/preview`),
never a per-story decorator.

## Recharts specifics

- **Tick label margins**: default `bottom: 24` exists because tick labels
  render inside `margin.bottom` (4px tickMargin + 11px font + descender);
  anything under ~16px clips descenders — very visible under the card's
  `overflow: hidden`.
- **Highlight dots**: custom `dot` renderers beat extra `Scatter` series —
  Scatter draws a symbol for every row including nulls, so highlights arrive
  with phantom points attached.
- **Lines between sparse points**: efforts are weeks apart; `type="linear"`
  beats a spline that would invent times between them.
- Shared Recharts numeric tokens live in
  `packages/design-system/src/chart-tokens.ts`; use `getChartTokens(mode)` in
  any new chart view. MapLibre/canvas colours are concrete hex, not CSS vars.
- Speed, pace and their labels come from `speedDisplay` in `packages/data`
  (#63); a stopped pace sample is a gap. Pace axes take `percentileRange` as
  their domain with `allowDataOverflow`.

## Headless primitives (Base UI)

[Base UI](https://base-ui.com/) (`@base-ui/react`, pinned in `packages/ui`) is
the headless primitive of record for any non-trivial interactive control —
anything needing focus management, positioning, dismissal, or roving tabindex
(Select, Menu, Dialog, Popover, Combobox, Slider, ToggleGroup). Reach for it
before hand-rolling these. Keep styling in CSS Modules with `data-*` selectors
(Base UI exposes `data-pressed`, `data-disabled`, etc.). Use `@base-ui/react`,
not the frozen `@base-ui-components/react`.

- `Pill` / `PillGroup` and `Legend` / `LegendItem` are built on Base UI
  `Toggle` / `ToggleGroup`: the group provides `role="group"`, arrow-key roving
  focus, one Tab stop; pressed values derive from children props so public APIs
  stay unchanged.
- Not everything needs a primitive: `Tooltip` (inside Recharts' tooltip, which
  owns positioning), `Skeleton`, and `AppShell` are presentational and stay
  hand-rolled.

## View-exposed tools (host-driven views)

`App.registerTool` lets the model drive a rendered view ("show me the climb at
14 km" pans the map instead of describing it). Two SDK constraints collide, and
`packages/ui/src/viewTools.ts` resolves them: registration must happen before
`connect()` (`registerTool` only advertises the capability while `!transport`),
while the state a tool acts on (map viewBox, brush window) only exists after.
So the declaration registers up front against a stable shim in `onAppCreated` —
the one pre-connect seam `useApp` offers — and the component installs the live
implementation with `useViewTool`. A call landing before the view mounts
answers "still loading, or it failed to load" (a card showing its ErrorState
never mounts the handler either), not an SDK throw.

**There is deliberately no host-capability gate**: `McpUiHostCapabilities` has
no key meaning "the host calls tools the *app* exposes", a gate could not work
anyway (capabilities arrive after registration must have happened), and none is
needed — registering pre-connect sends nothing, so an unsupporting host sees
one extra key it already ignores.

Schemas are zod objects (`.strict()`, every field `.nullish()`): zod 4
implements Standard JSON Schema, which `registerTool` needs, and already ships
in every app through ext-apps. The registry drops null-valued arguments before
the handler runs, so null means not given. Every field is optional because a
view tool is a nudge. View tools carry `readOnlyHint: true` **with
`destructiveHint: false` stated explicitly**. Each tool echoes its effect back
through the existing `useModelContextSync` summary.

An app declares its tools in `src/viewToolDeclarations.ts` (exporting
`VIEW_TOOLS`; `main.tsx` renders on import, so a test cannot reach a
declaration there). Its `viewToolDeclarations.test.ts` calls
`expectViewToolContract(VIEW_TOOLS)` from `@intervals-mcp/ui/testing`, which
drives the declarations through a real `App` the way a host does: strict object
with nothing required, read-only annotations, every field accepts `null`, an
unknown key is rejected. The same test pins the tool's field names, bounds and
prose with `advertisedViewTools` and `viewToolFields`. A field missing
`.nullish()` or an object missing `.strict()` otherwise fails only when a host
calls the tool.

---

## Per-app notes

### Activity Chart

`view-activity-chart` renders an interactive Recharts chart (HR, power, pace,
altitude overlays; cadence and grade where recorded).

- X-axis `Brush` zoom: drag handles to zoom into a window; the window is
  controlled state joined to the memoized chart-tree deps (an uncontrolled
  Brush resets whenever the tree rebuilds), so it survives preset/legend/
  smooth toggles. Brush internals are themed via `:global` selectors in the
  CSS module.
- Lap/segment band labels sit top-left per band; `selectLapLabels`
  (`src/lapLabels.ts`, unit-tested) walks bands against the visible axis window
  and measured plot width, drawing a label only when its text clears the
  previously drawn one — the first of a crowded run wins, the rest drop out.
  Plot width comes from a `ResizeObserver` bucketed to ~24px (floored at a
  mode-based estimate) so minor reflows don't churn the memoized tree.
- Running-dynamics overlays (ground contact time, vertical oscillation, and
  related metrics recorded on run activities) are available via the "Form"
  preset, which draws them alongside its own legend toggles on top of the
  base metric set.
- A metric that is present but `null` at a given sample (a real gap in the
  recorded stream) draws as a break in the line rather than a fabricated
  zero, spike, or interpolated value; see the `gappyRun` fixture and stories
  for the intended rendering.
- A stream-less activity arrives as `noStreams: true` with an empty `time`
  stream and shows the EmptyState; there is no retry, because a retry cannot
  succeed (#65). `set-brush-window` answers an empty chart with the same
  no-streams error, reset included. A time window (`fromSeconds` / `toSeconds`)
  zooms a swim through its `time` values, since Brush is index-based and the
  swim's axis is distance; mixing km and seconds in one call is refused. The
  reply describes the window on the axis it was asked in, the context summary
  on the brush's own axis.

### Cadence Trends

Four views: Trend timeline, Scatter plot, Pace Zones, Overlay comparison.
Calls `get-cadence-trend-data` on mount with `days` (the payload echoes
`days`; the subtitle and context summary say "last 6 weeks" for a whole
number of weeks, else "last 30 days", as the server's view text does) and
`get-activity-streams-raw` for per-second overlays on demand through the
shared `useServerToolFetcher` (one
keyed fetch per selected run, each with its own loading/error/retry). The
overlay's loading state shows the progress line of the first selected run
that is still loading.

Overlay run selection has two entry points sharing `toggleRunSelection` (capped
at 4): clicking Trend/Scatter dots, and `RunSelectList.tsx` — a Base UI
`ToggleGroup` of chips (roving tabindex, one Tab stop, `aria-pressed` per run).
Recharts `Cell` dots carry no tabindex/role/key handling, so the picker is the
accessible alternative rather than fighting SVG focus. Unselected chips disable
at the cap so the limit is legible.

`set-view` (`view`, `runIds` up to 4, `xAxis`) lets the model drive the view;
`runIds` replaces the selection, in the order given, so overlay colours follow
it. The model never sees the chart's runs, so the description points it at
`list-activities` for ids. `resolveSetView` (`src/setView.ts`, unit-tested)
matches an id with or without the `i` prefix (not `"latest"`), and a refusal
names ids the chart lacks apart from runs with no cadence, each once; a
`runIds` or `xAxis` without a `view` moves to the overlay, while an empty
`runIds` only clears the selection. The overlay x-axis and the legend's hidden runs are `App` state
(`OverlayView` is controlled), and the context summary reports the axis while
the overlay shows. Like `set-scope`, the reply claims "Showing" only for what
is drawn: `overlayRunStatus` (`src/normalize.ts`, the reading the overlay
draws from) puts each selected run in one of drawn, hidden, loading,
noStreams or failed, and the reply and the overlay's context summary name the
rest by state ("Tempo is still loading.", "Hidden in the legend: Tempo."). The
reply goes out before a new run's fetch starts, so it says such a run is still
loading. `runIds` shows any run in it the legend had hidden; leaving the
overlay shows every run again, as when the overlay owned that state.

Trend uses a time axis (`dateTs`, UTC day), so gaps in running show as gaps.
Runs on one day share an x, and Recharts' `ComposedChart` has only an axis
tooltip, which picks one row for all of them; the trend tooltip therefore
lists every run that day (`runsByDay`), name, cadence and pace each. Zone
whiskers run from min to max (`buildZoneRows`). Overlay colours follow selection
order (`assignOverlayColors`); runs sharing a name are labelled with their date
(`overlayRunLabel`). A selected run that loaded with `noStreams: true` (#65) is
left out of the lines and named in a muted note, with no retry; if every
selected run is stream-less the overlay shows an EmptyState. The pace Scatter
reads the chart's own data and Recharts skips a null pace; a Scatter-level
`data` filter makes the shared tooltip show the wrong run for some dots.

### Route Map

The most complex app; defaults to a MapLibre basemap with a pure-SVG offline
grid fallback (no Recharts). Calls `get-route-map-data` (app-only) with
`id`.

- Geometry always comes from the `latlng` stream: intervals.icu has no
  encoded-polyline endpoint (`GET /activity/{id}/map` returns the same
  latlng stream at the same resolution, nothing more; see docs/api-notes.md).
  Samples whose latlng is `null` are dropped from every aligned stream at
  that index, then everything is jointly downsampled to about 1,000 points:
  lat/lng/time/distance take the bucket's last sample so the axes stay
  gap-free, other metrics take the bucket mean of non-null samples and may
  still render as a gap. Stream-less (manual) activities have no GPS at all
  and render with no route.
- Projection math (`src/normalize.ts`): fit to bounds with padding, scale
  longitude by `cos(latitude)`, flip latitude so north is up.
- Metric colouring when streams exist (`src/metrics.ts`): binned same-colour
  path runs, gradient legend, pointer/touch scrub (nearest-point crosshair +
  tooltip), linked elevation strip (`src/elevationProfile.ts`) sharing the
  scrub index.
- Zoom/pan via SVG viewBox windowing (`src/panZoom.ts`): wheel+drag desktop,
  pinch+drag mobile, keyboard (focusable region; arrows pan, `+`/`-`/`0`
  zoom/reset) plus always-visible zoom buttons; changes announced via polite
  `aria-live`. Clamped to base frame; marker/stroke sizes counter-scale.
  `touch-action`: `pan-y` at base zoom, `none` once zoomed.
- Annotation layers, each toggleable via the footer legend: a marker at the
  end of every WORK interval (`activity.icu_intervals`; RECOVERY intervals
  get no marker, since the app only shows the splits a runner planned, not
  intervals.icu's rest/auto-pause segmentation), km split dots
  (`src/annotations.ts`; km marks thinned 1/2/5… per length), and
  caller-pinned waypoints. WORK-interval end times are resolved to coordinate
  indices via `indexAtOrAfterTime` (`apps/server/src/streamDownsample.ts`,
  called from `buildLapMarkers` in `routeMapData.ts`), by time rather than by
  intervals.icu's own indices, because those reference the full-resolution
  recorded stream, not the downsampled one the map renders. Waypoints are
  anchored by km in `apps/server/src/mapAnchors.ts`, which only handles
  waypoints, not lap markers.
- Waypoints: `waypoints` array (`km`, `label`, `kind: fuel|climb|water|custom`)
  anchored by cumulative distance (`resolveWaypoints` in `mapAnchors.ts`;
  recorded distance stream when present, else haversine cumulative distances).
  Out-of-range waypoints drop into `waypointWarnings`. Per-kind coloured
  diamonds on grid and elevation strip; colored circles on the basemap
  (`WAYPOINT_COLORS` — concrete hex, theme-invariant); counted in the a11y
  narration.
- Screen-reader narration (`src/a11yDescription.ts`): kind, distance, climb,
  loop vs point-to-point, geographic extent, altitude range, colour metric,
  annotation counts — in both views (SVG `<title>`/`<desc>` wiring asserted by
  SSR-markup tests; basemap as visually-hidden text + canvas `aria-label`).
- Screen-reader narration aside, the basemap (`src/BasemapView.tsx`) is the
  **default view**; a failed style load falls back silently to the offline SVG
  grid (keeping SVG zoom/pan). Track renders as GeoJSON line features reusing
  the same colour binning (`buildColorRuns` in `src/basemapData.ts`). Native
  MapLibre zoom/pan behind `cooperativeGestures`; OSM attribution via control;
  scrub tooltip positioned via `map.project`.
- `set-viewport` and reset frame the basemap camera through `BasemapView`'s
  `frame` prop (`src/basemapCamera.ts`, padding 36, max zoom 17); a frame
  sent before the style loads is applied on load, or, if the style fails
  instead, framed and announced on the grid (`gridViewForRange`, #144). The
  argument checks and their error texts live in `src/viewportRequest.ts`, so
  both views give the same reply.
- The live region and the model context say which stretch of the route is
  in view, in one wording for both views (`visibleRoute` and `describeView`
  in `src/viewport.ts`, #53): "Showing the whole route" exactly when every
  track point is in view, otherwise the stretches in view by km ("Showing
  12.0–16.0 km of the route"; a loop's start reads as its first and last
  kilometres). A point is in view inside the grid's viewBox, or inside the
  basemap bounds MapLibre reports on every `moveend` (the model's frame, the
  user's own pan, zoom or resize). With no distance stream the wording falls
  back to the zoom factor. The grid announces only button, keyboard (zoom
  and arrow-key pan, all through `applyView`) and model moves; wheel, pinch
  and drag reach the model context without an announcement.

**Basemap tile source and CSP.** The route-map resource declares
`_meta.ui.csp` on **both** descriptor and content response:

```jsonc
{ "ui": { "prefersBorder": false, "csp": {
  "connectDomains": ["https://tiles.openfreemap.org"],
  "resourceDomains": ["https://tiles.openfreemap.org"]
} } }
```

Tile origin is OpenFreeMap's public Liberty instance: $0, no key, no infra, one
CSP origin for style + tiles + glyphs + sprites, stock MapLibre style URL. Its
risk (donation-funded, no SLA) is covered by the offline-grid fallback, with
self-hosting OpenFreeMap or a Protomaps PMTiles extract on R2 as the escape
hatch — those add cost and either another origin or the `pmtiles` protocol
shim, so they wait until the public instance actually degrades. The Claude
host honours the CSP allowlist on desktop/web and iOS.

**MapLibre worker bundling is load-bearing.** maplibre-gl (v6, ESM-only) is
inlined by the single-file build. Its worker is an ES module importing a shared
sibling chunk, which a Blob-spawned worker inside one HTML file could never
resolve, so the `bundledRawWorker` plugin (`packages/vite-config/maplibre-worker.ts`)
serves BasemapView's `maplibre-gl/dist/maplibre-gl-worker.mjs?bundled-raw`
import as that module flattened into one self-contained IIFE by a nested Vite
build; BasemapView hands the string over as a Blob URL via
`maplibregl.setWorkerUrl`. A worker re-bundled as part of the app build loses
its GeoJSON code path once vite-plugin-singlefile flattens the bundle: tiles
render but every GeoJSON overlay (track, markers, halos) throws in the worker
and silently vanishes. The nested build keeps the worker outside the app graph,
entering only as a string literal. The plugin must stay registered wherever
route-map sources are served: route-map's vite.config (build + vitest) and
Storybook's `viteFinal`. Bundle: ~2.12 MB raw (~554 KB gz).

Grid stories pin `basemapEnabled: false` (deterministic offline fallback, no
live tiles) so browser-mode story tests stay hermetic; the Basemap stories
exercise the real default view.

### Training Load

Weekly running-volume bars with rolling trend line and volume-spike warning
weeks, a weekly load line, and Fitness/Fatigue/Form tiles. Calls
`get-training-load-data` with the `days` window (default 84, max 365) and the
`runOnly` scope the view tool was called with (default false). `runOnly` has
to travel: the data tool defaults to whole-body, so dropping it would draw a
whole-body chart under a run-only request. `buildDataArgs` (`normalize.ts`)
builds the arguments, unit-tested. Volume and spike warnings are always
run-based; load and CTL/ATL/TSB follow `runOnly`.

- Server-side aggregation is pure and unit-tested in
  `apps/server/src/trainingLoad.ts` (`buildTrainingLoadData`): Monday-start
  weekly buckets over a whole-week window (`days` rounded up to whole weeks,
  plus the current week so far; `startDate`/`endDate` in the payload), gap
  weeks zero-filled so the timeline stays continuous and runs on to the
  current week (a layoff that is still going on shows as empty weeks), a
  centered rolling-average trend over complete weeks, per-week warning flags
  with reasons. The weeks the warnings read (`selectRunWeeks`, with the 4
  weeks before the window as a baseline only) and the rule
  (`computeWeekWarnings`: a week over 1.5 times the average of the 4 complete
  weeks before it, #60) are shared with the `get-training-load` text tool, so
  chart and prose cannot drift (#43). The tooltip shows the reason as the
  server wrote it; the narration and model context call the weeks volume
  spikes, not injury risk.
- The current week carries `inProgress: true` and `trendKm: null`: it draws
  as a light dashed bar with a "This week so far" legend key, the trend line
  ends at the last complete week, and the tooltip, narration and model
  context all say the week is in progress.
- `ComposedChart`: weekly distance bars (warning weeks recoloured in the
  danger hue) plus trend `Line` on the `distance` axis, and weekly `load` as a
  linear `Line` on its own right-hand `load` axis (load runs to the hundreds
  against tens of km, so one shared axis would flatten both). The shared scrub
  tooltip lists distance, trend, load and its per-type breakdown (largest
  first), runs, time, elevation, warnings. Footer `Legend` toggles trend line,
  load line (the right axis hides with it) and warning highlighting; mobile
  drops the axis titles.
- The week in progress holds only the days so far, so `buildLoadRows` keeps its
  load off the solid line (the way `trendKm` is null for it) and the chart
  draws it as a hollow point of its own beside the dashed partial bar. On the
  line it would read as a plunge in load. The tooltip still reads its `load`,
  and the narration ranges the load line over complete weeks.
- A right-hand axis lists ticks from the axis line outward, so the "Load"
  title needs a gutter past the widest tick (sized from the axis font for four
  digits, so a 1,000+ load clears it). The `LoadChart` stories assert that no
  axis title's box meets a tick label's, including a four-digit story.
- The `SummaryBar` reads Runs, Distance, Load, Fitness, Fatigue, Form; the
  three fitness tiles are dashes when `current` is null. A scope note under it
  (`buildScopeNote`: "Whole-body load (Run, Ride) · from intervals.icu as of 5
  Oct" or "Run-only load · computed locally as of 5 Oct") says what the load
  and the tiles add up. The narration and model context carry the total load,
  the scope and CTL/ATL/TSB with its source. Form is signed by
  `formatSignedTsb` and the source by `fitnessSourceLabel`, both in
  `packages/data` and shared with fitness-trend.
- The `view-training-load` text prints the same numbers: a `Scope:` line and a
  `Current (as of DATE): CTL x / ATL y / TSB +z` line, with its `Load:` total
  equal to the payload's `totals.load`.

### Compare Activities

Overlays two activities' streams so the user can see WHERE the difference
happened (the text `compare-activities` tool reports aggregates only). Takes
`activityId1` + `activityId2`; calls `get-activity-streams-raw` once per
activity (TTL-cached server-side) and `get-compare-activities-data` for the
delta summary bar. That tool reuses the text tool's aggregate logic, extracted
as pure `buildComparison` in `apps/server/src/tools/compareActivities.ts`.

- Alignment is pure and unit-tested in `src/align.ts`: both activities
  resample onto one uniform grid over the shared distance or time axis
  (`alignSeries`, linear interpolation, light post-smoothing), so the tooltip
  shows a per-point activity2−activity1 delta and a shorter line simply ends.
  Pace renders as pace (reversed axis) only when both activities share a pace
  sport (`speedSport`); mixed pairs fall back to km/h.
- One metric at a time (intersection of what both recorded), distance/time
  axis toggle, legend toggles per activity line (blue/orange).
- Delta summary header degrades away if that fetch fails while the overlay
  still renders.
- A stream-less side (`noStreams: true`, #65) is data, not an error: it keeps
  the delta tiles and shows the overlay EmptyState, with no retry.
- `set-metric` (`metric`, `axis`) lets the model choose the overlay. A metric
  or axis the pair did not both record is refused with the available ones listed
  (`resolveSetMetric`, `src/setMetric.ts`, unit-tested). The list names the value
  the strict enum accepts, with the displayed label beside it only where it
  differs (`pace (shown as speed)` for a mixed-sport pair, `heartrate (shown as
  heart rate)`), so a model following the list never sends a value the schema
  rejects. Either part being unavailable refuses the whole call, and a
  stream-less side gets a plain "nothing to choose" answer rather than an empty
  list. The success reply and the context summary's `Overlay:` line use the
  displayed label, as the pills do.

### Activity Zones

One activity's time-in-zone distribution (ljcl/strava-mcp#34). Calls
`get-activity-zones-data` on mount.

- The server maps the activity's own `icu_zone_times`/`icu_hr_zones` fields
  (same `GET /activity/{id}` fetch behind the `get-activity-zones` text tool)
  to chart-ready sets in `apps/server/src/activityZones.ts`
  (`mapIntervalsZones`): per-bucket seconds and percentages, the `-1`
  open-ended top bucket normalised to `null`, sets without buckets or zero
  time dropped. Power zones are dropped for now (see docs/api-notes.md).
- One `BarChart` per zone set (HR in `--chart-heartrate`, power in
  `--chart-power`, opacity ramp Z1→Zn), pct labels on top, shared tooltip; a
  `PillGroup` switches HR/power when both exist; estimated (non-sensor) power
  sets carry a footnote.
- Pure logic in `src/normalize.ts` (`buildZoneRows`, `intensitySplit` — zones
  1–2 easy / 3 moderate / 4+ hard, `buildSummaryStats`).
- The subtitle date is `start_date_local`, a local date-time with no offset.
  `formatShortDate` reads its leading `YYYY-MM-DD` as written, so the day
  does not move with the viewer's time zone.
- With no zone set to chart, `EmptyState` shows `buildEmptyMessage`: the
  payload's `hrZoneWarning` when the server dropped heart rate zones for a
  known reason (the same line the text tools print), else a neutral line
  that names no cause.

### Fitness Trend

Performance-management chart: fitness, fatigue, form, and where the next few
weeks take them. Calls `get-fitness-trend-data` on mount with `days`,
`projectDays`, optional `targetDate`/`targetTsb`.

- **No new math.** `fitnessTrend.ts` computes series, bands, taper;
  `fitnessTrendApp.ts` (`mapFitnessTrendApp`) only renames to camelCase for the
  wire. The `view-` tool's text prints the same headline numbers and weekly
  loads so chart and prose cannot drift.
- Warning bands are **dated server-side** (`trendBands`), and `computeFlags`
  filters to bands running to today. The app could not derive them itself
  without copying `DEEP_FATIGUE_TSB` and friends across the boundary, and a
  chart shading a different "deep fatigue" than the prose describes is the
  drift the split prevents. An old resolved block still shades; only a current
  one flags. Fresh bands have hysteresis and merge server-side, so TSB moving
  around +15 shades one band, not stripes.
- The "Fresh on" tile and the context summary read `tsbPositiveDate` against
  the payload's `endDate` (today): equal means form is already positive today,
  so the tile says "Today" rather than a date. The server sets the date; the
  app only compares.
- The narration's 7-day fitness change is the payload's `ctl7dDelta`
  (`ctlDelta`, by date), the text tool's `ctl_7d_delta`. The app must not
  count rows back in `series`: a whole-body series skips days with no
  wellness, so 7 rows can be 9 calendar days.
- `ComposedChart`: fitness `Area` left axis, fatigue line beside it, form
  thinner line on its own right axis with dashed zero line. The forward half
  draws as separate `plan*` series with `strokeDasharray`; handover day carries
  **both** keys, else the dashed line starts a day adrift of the solid one
  (`buildChartRows`).
- Forward half = solved taper when the caller named a target date, else rest
  projection; legend and tooltip say which, because a prescribed number reading
  as recorded is the worst outcome. `TaperPlanList.tsx` prints weeks under the
  chart, hides with the plan toggle.
- One legend toggle **per band kind present** (`countBandKinds`): a window
  routinely carries fatigue and ramp bands at once and reads as one smear
  otherwise.
- Story fixture is **generated** by running real `buildFitnessTrend` over a
  scripted 12-week block — CTL/ATL are recurrences, so a handwritten series
  charts a shape the server can never produce.
- A "Whole body" / "Runs only" `PillGroup` (`App.tsx`) switches the `runOnly`
  scope. The scope not shown at mount is fetched on demand through the shared
  keyed `useServerToolFetcher` store and cached, so flipping back never
  re-fetches; `fitnessSourceLabel` (`packages/data`, shared with
  training-load) notes when a scope's numbers are computed locally rather than
  read from intervals.icu. While that fetch runs, the skeleton
  shows its progress line. If it fails, `ErrorState` shows the error and a
  retry that calls the tool again.
- `set-scope` (`scope`, `show`, `hide`) lets the model switch the scope pills
  and the legend toggles for `fitness`, `fatigue`, `form` and `plan`. It sets
  the same state the pills do, so the other scope arrives through the keyed
  fetcher above and there is no second fetch path. `resolveSetScope`
  (`src/setScope.ts`, unit-tested) refuses a series named in both lists and a
  `plan` the landing scope has no rows for (a scope still loading is given the
  benefit of the doubt), naming series by the value the schema accepts. The
  reply and the context summary list what is hidden the same way, noting what
  the legend calls the plan ("taper plan" or "rest projection"). The reply
  claims "Showing" only for a chart that is drawn (`landingFor` reads the
  landing scope's render state): a scope still loading is "Switching to ...;
  it is still loading", a failed fetch is an error carrying what the card
  shows, and a loaded scope with no recorded load is refused with nothing
  changed, because the legend would still render over an EmptyState. The state
  change is kept while a scope loads or fails. Band-kind toggles are not
  exposed.
