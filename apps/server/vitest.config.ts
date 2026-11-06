import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // The route store writes under DATA_DIR; tests never write into the repo.
    // A test that reads back what it stored stubs its own directory.
    env: { DATA_DIR: join(tmpdir(), `intervals-mcp-vitest-${process.pid}`) },
    coverage: {
      provider: "v8",
      // json-summary feeds the CI job-summary table (scripts/coverage-summary.ts).
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/mcpTestClient.ts",
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
        statements: 93,
        branches: 86,
        functions: 94,
        lines: 93,
      },
    },
  },
});
