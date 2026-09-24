import { build, type Plugin, type Rollup } from "vite";

/**
 * Serves `<specifier>?bundled-raw` as a string of that module bundled into a
 * single self-contained script (IIFE, dynamic imports inlined, minified).
 *
 * Exists for maplibre-gl v6, which ships its worker as an ES module importing
 * a shared sibling chunk (`maplibre-gl-worker.mjs` → `maplibre-gl-shared.mjs`).
 * The route-map MCP App must hand MapLibre a worker it can spawn from a Blob
 * URL — inside a single-file HTML bundle there is no sibling file to resolve
 * against, so the import graph has to be flattened into one script first.
 * v5's pre-built CSP worker did that for us; v6 dropped it, so this plugin
 * does the flattening at build time via a nested Vite build.
 *
 * The specifier is resolved against the *importer* (route-map's sources), not
 * this package — maplibre-gl is route-map's dependency, invisible from here.
 */
const QUERY = "?bundled-raw";
const RESOLVED_PREFIX = "\0bundled-raw:";

export function bundledRawWorker(): Plugin {
  // One nested build per entry per process, shared across importers.
  const bundled = new Map<string, Promise<string>>();
  return {
    name: "intervals-mcp:bundled-raw-worker",
    enforce: "pre",
    async resolveId(id, importer) {
      if (!id.endsWith(QUERY)) return;
      const resolved = await this.resolve(
        id.slice(0, -QUERY.length),
        importer,
        { skipSelf: true },
      );
      return resolved ? RESOLVED_PREFIX + resolved.id : undefined;
    },
    async load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return;
      const entry = id.slice(RESOLVED_PREFIX.length);
      let code = bundled.get(entry);
      if (!code) {
        code = bundleToSelfContainedScript(entry);
        bundled.set(entry, code);
      }
      return `export default ${JSON.stringify(await code)};`;
    },
  };
}

async function bundleToSelfContainedScript(entry: string): Promise<string> {
  // logLevel "error": the worker keeps a runtime `import(url)` for MapLibre's
  // external-plugin loader (never taken here — nothing calls
  // setRTLTextPlugin), and the preload helper wrapping it warns about
  // `import.meta` under the iife format on every build.
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      // IIFE so the script runs identically as a module or classic worker
      // (MapLibre falls back to a classic worker where module workers are
      // unsupported). The chunk-count check below is the guard that the
      // graph really flattened to one self-contained script.
      rollupOptions: {
        input: entry,
        // `name` keeps rollup happy should the entry carry exports.
        output: { format: "iife", name: "__bundledRawWorker" },
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs
    .flatMap((r) => ("output" in r ? r.output : []))
    .filter((o): o is Rollup.OutputChunk => o.type === "chunk");
  const chunk = chunks.length === 1 ? chunks[0] : undefined;
  if (!chunk) {
    throw new Error(
      `bundled-raw: expected one chunk for ${entry}, got ${chunks.length}`,
    );
  }
  return chunk.code;
}
