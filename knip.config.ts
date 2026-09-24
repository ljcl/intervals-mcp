import { type KnipConfig } from "knip";

export default {
  workspaces: {
    ".": {
      // Story smoke tests: non-default name so vitest's parent-directory
      // config search cannot hijack per-package bare `vitest run`.
      vitest: {
        config: ["vitest.stories.config.ts"],
      },
    },
    "apps/server": {
      project: ["src/**/*.ts"],
      // Resolved at runtime via createRequire(...).resolve("<pkg>/app.html"),
      // which knip cannot trace as a static import.
      ignoreDependencies: [
        "@intervals-mcp/activity-chart",
        "@intervals-mcp/activity-segments",
        "@intervals-mcp/activity-zones",
        "@intervals-mcp/cadence-trends",
        "@intervals-mcp/compare-activities",
        "@intervals-mcp/fitness-trend",
        "@intervals-mcp/route-map",
        "@intervals-mcp/segment-progress",
        "@intervals-mcp/training-load",
      ],
    },
    "packages/activity-chart": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/activity-zones": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/activity-segments": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/cadence-trends": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/compare-activities": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/fitness-trend": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/route-map": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/segment-progress": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/training-load": {
      entry: ["src/main.tsx"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/design-system": {
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/ui": {
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/storybook": {
      storybook: {
        config: [".storybook/main.ts"],
        entry: [
          ".storybook/{manager,preview,index,vitest.setup}.{js,jsx,ts,tsx}",
          "../../packages/activity-chart/src/**/*.stories.@(ts|tsx)",
          "../../packages/activity-segments/src/**/*.stories.@(ts|tsx)",
          "../../packages/activity-zones/src/**/*.stories.@(ts|tsx)",
          "../../packages/cadence-trends/src/**/*.stories.@(ts|tsx)",
          "../../packages/compare-activities/src/**/*.stories.@(ts|tsx)",
          "../../packages/fitness-trend/src/**/*.stories.@(ts|tsx)",
          "../../packages/route-map/src/**/*.stories.@(ts|tsx)",
          "../../packages/segment-progress/src/**/*.stories.@(ts|tsx)",
          "../../packages/training-load/src/**/*.stories.@(ts|tsx)",
          "../../packages/design-system/stories/**/*.stories.@(ts|tsx)",
          "../../packages/ui/src/**/*.stories.@(ts|tsx)",
        ],
        project: [".storybook/**/*.{js,jsx,ts,tsx,mts}"],
      },
      // Consumed by Storybook's `stories` directory globs at build time (the
      // story files are co-located in each package and import relatively), so
      // there is no static `@intervals-mcp/*` import for knip to follow.
      ignoreDependencies: [
        "@intervals-mcp/activity-chart",
        "@intervals-mcp/activity-segments",
        "@intervals-mcp/activity-zones",
        "@intervals-mcp/cadence-trends",
        "@intervals-mcp/compare-activities",
        "@intervals-mcp/fitness-trend",
        "@intervals-mcp/route-map",
        "@intervals-mcp/segment-progress",
        "@intervals-mcp/training-load",
        "@intervals-mcp/ui",
      ],
    },
  },
  ignoreExportsUsedInFile: true,
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/@(?:import|plugin)\s+["']([^"']+)["']/g)]
        .map(([_, dep]) => `import "${dep}";`)
        .join("\n"),
  },
} satisfies KnipConfig;
