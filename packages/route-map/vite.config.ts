import { bundledRawWorker } from "@intervals-mcp/vite-config/maplibre-worker";
import { mcpAppConfig } from "@intervals-mcp/vite-config/mcp-app";
import { mergeConfig } from "vite";

// bundledRawWorker serves BasemapView's `?bundled-raw` worker import — the
// MapLibre worker flattened into one self-contained script. Registered here
// (build + this package's vitest) and in Storybook's viteFinal.
export default mergeConfig(mcpAppConfig("route-map"), {
  plugins: [bundledRawWorker()],
});
