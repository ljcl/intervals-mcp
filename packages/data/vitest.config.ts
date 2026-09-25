import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // json-summary feeds the CI job-summary table (scripts/coverage-summary.ts).
      reporter: ["text", "json-summary"],
      // High regression floor: this package measures ~100%, so any
      // drop is meaningful. Auto-ratcheted to 2 points under measured
      // coverage; a full `test:coverage` run rewrites the numbers in place
      // (they always equal floor(actual − 2)); commit the rewrite, don't
      // hand-edit.
      thresholds: {
        autoUpdate: (newThreshold: number) => Math.floor(newThreshold - 2),
        statements: 98,
        branches: 98,
        functions: 98,
        lines: 98,
      },
    },
  },
});
