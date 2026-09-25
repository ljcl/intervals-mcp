import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // json-summary feeds the CI job-summary table (scripts/coverage-summary.ts).
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/server.ts",
        "src/index.ts",
        "**/__fixtures__/**",
      ],
      // Regression floor: auto-ratcheted to 5 points under measured
      // coverage, so genuine drops fail CI without flaking on small
      // refactors, and the floor rises as coverage grows. Any full
      // `test:coverage` run rewrites these numbers in place (they always
      // equal floor(actual − 5)); commit the rewrite, don't hand-edit.
      thresholds: {
        autoUpdate: (newThreshold: number) => Math.floor(newThreshold - 5),
        statements: 91,
        branches: 78,
        functions: 93,
        lines: 92,
      },
    },
  },
});
