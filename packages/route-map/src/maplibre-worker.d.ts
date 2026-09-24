// The `?bundled-raw` query is served by the `bundledRawWorker` plugin
// (@intervals-mcp/vite-config): MapLibre's ES-module worker flattened into one
// self-contained script, exported as a string. See BasemapView.tsx for why a
// single-file bundle needs the worker pre-flattened.
declare module "maplibre-gl/dist/maplibre-gl-worker.mjs?bundled-raw" {
  const code: string;
  export default code;
}
