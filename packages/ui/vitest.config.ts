import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The shared hooks are the one runtime path every MCP App goes through,
    // and they only exist in a rendered tree — the story tests never reach
    // them because no app's `main.tsx` has a story. Component and
    // view rendering stays in the browser-mode story tests; this environment
    // is here for the hooks.
    environment: "happy-dom",
    coverage: {
      provider: "v8",
      // json-summary feeds the CI job-summary table (scripts/coverage-summary.ts).
      reporter: ["text", "json-summary"],
      // Regression floor, auto-ratcheted to 5 points under measured
      // coverage on every `test:coverage` run; commit the rewrite rather
      // than hand-editing the numbers.
      thresholds: {
        autoUpdate: (newThreshold: number) => Math.floor(newThreshold - 5),
        statements: 87,
        branches: 86,
        functions: 76,
        lines: 87,
      },
      // The presentational components are covered by the story render-path
      // report, not here; thresholding them twice would just double-count.
      include: [
        "src/useServerToolData.ts",
        "src/useServerToolFetcher.ts",
        "src/useModelContextSync.ts",
        "src/useMobileMode.ts",
        "src/keyedFetchStore.ts",
        "src/serverToolResult.ts",
        // The schema helper is only ever called from an app's `main.tsx`,
        // which has no story — so the render-path report measures it at 0%
        // and it needs a floor here. Its sibling `viewTools.ts` is
        // deliberately NOT here: `useViewTool` runs inside RouteMap and
        // ActivityChart, both storied, so the render-path report already
        // floors it. Listing it again would double-count and pull this
        // report's aggregate (and therefore its ratchet) down ~4 points on
        // the hooks this floor exists to guard.
        "src/standardSchema.ts",
      ],
    },
  },
});
