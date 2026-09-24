import { bundledRawWorker } from "@intervals-mcp/vite-config/maplibre-worker";
import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
  // route-map's BasemapView imports its MapLibre worker via `?bundled-raw`,
  // served by this plugin (see @intervals-mcp/vite-config). Registered here so
  // Storybook dev/build and the story smoke tests resolve it.
  viteFinal: (config) => {
    config.plugins = [...(config.plugins ?? []), bundledRawWorker()];
    // Keep maplibre-gl out of the dep optimizer: v6 is pure ESM (no CJS
    // interop to pre-bundle), and letting the optimizer discover it mid-run
    // re-hashes already-served chunks — on a cold cache (CI always is) that
    // kills unrelated story suites with "Failed to fetch dynamically
    // imported module". Excluded deps never trigger that reload.
    config.optimizeDeps = {
      ...config.optimizeDeps,
      exclude: [...(config.optimizeDeps?.exclude ?? []), "maplibre-gl"],
    };
    return config;
  },
  addons: [
    "@storybook/addon-mcp",
    "@storybook/addon-vitest",
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
  ],
  framework: "@storybook/react-vite",
  stories: [
    {
      titlePrefix: "Activity Chart",
      directory: "../../../packages/activity-chart/src/",
    },
    {
      titlePrefix: "Cadence Trends",
      directory: "../../../packages/cadence-trends/src/",
    },
    {
      titlePrefix: "Route Map",
      directory: "../../../packages/route-map/src/",
    },
    {
      titlePrefix: "Activity Segments",
      directory: "../../../packages/activity-segments/src/",
    },
    {
      titlePrefix: "Segment Progress",
      directory: "../../../packages/segment-progress/src/",
    },
    {
      titlePrefix: "Training Load",
      directory: "../../../packages/training-load/src/",
    },
    {
      titlePrefix: "Fitness Trend",
      directory: "../../../packages/fitness-trend/src/",
    },
    {
      titlePrefix: "Compare Activities",
      directory: "../../../packages/compare-activities/src/",
    },
    {
      titlePrefix: "Activity Zones",
      directory: "../../../packages/activity-zones/src/",
    },
    {
      directory: "../../../packages/design-system/stories/",
    },
    { titlePrefix: "UI", directory: "../../../packages/ui/src/" },
  ],
});
