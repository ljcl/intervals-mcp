import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { resolveChromiumExecutablePath } from "./scripts/playwright-chromium";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Story smoke tests (`bun run test:stories`): every Storybook story renders in
 * real headless Chromium via the Storybook Vitest addon. Per-package unit
 * tests stay as turbo `test` tasks with their own configs; this root config
 * owns only the story project. No setup file is needed — all stories use CSF
 * factories, so each story carries its preview annotations itself.
 *
 * Deliberately NOT named vitest.config.ts: vitest searches parent directories
 * for a config, so a default-named root config would hijack every package's
 * bare `vitest run` (most packages run on defaults with no local config).
 * Only the explicit --config flag in the root test:stories script loads it.
 */
export default defineConfig({
  test: {
    // Coverage is opt-in (`test:stories:coverage`, the CI story-test step):
    // it measures which packages/* source the stories actually execute in the
    // browser — the render-path floor for the view-heavy packages whose unit
    // coverage is intentionally low (ljcl/strava-mcp#197). Reports land in coverage-stories/
    // (distinct from the per-package coverage/ dirs) and feed a separate row
    // in scripts/coverage-summary.ts.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage-stories",
      // Regression floor (ljcl/strava-mcp#276), the same auto-ratchet the per-package configs
      // use: the view packages' only regression signal previously gated
      // nothing, so a story that stopped rendering a branch cost no coverage
      // anywhere. Cushion is 5 points, matching apps/server — the two seeding
      // runs measured identically, but this is browser-mode coverage and a
      // story whose async work settles differently can move it, so the floor
      // is deliberately not tight. Any `test:stories:coverage` run rewrites
      // these numbers in place; commit the rewrite, don't hand-edit.
      thresholds: {
        autoUpdate: (newThreshold: number) => Math.floor(newThreshold - 5),
        statements: 68,
        branches: 59,
        functions: 71,
        lines: 71,
      },
      // The storybookTest addon pins the project root to apps/storybook, so
      // every packages/* source is "external" to coverage; without this the
      // report is empty.
      allowExternal: true,
      exclude: [
        "**/*.stories.{ts,tsx}",
        "**/*.test.{ts,tsx}",
        "**/__fixtures__/**",
        "**/.storybook/**",
        // A storybook-builder virtual module whose sourcemap resolves to the
        // bare project root; it is not a real source file.
        "**/apps/storybook",
        "**/vite-env.d.ts",
        "**/*.d.ts",
      ],
    },
    projects: [
      {
        plugins: [
          storybookTest({
            configDir: path.join(dirname, "apps/storybook/.storybook"),
            storybookScript: "bun run storybook",
          }),
        ],
        test: {
          name: "storybook",
          // The addon pins the project root to apps/storybook (configDir/..)
          // but resolves story globs against this dir; both must agree or no
          // story files are found. Keep it at the repo root, where the
          // co-located packages/*/src story files live.
          dir: dirname,
          browser: {
            enabled: true,
            provider: playwright({
              // Undefined on a normally provisioned machine (CI installs the
              // pinned build), so this is a no-op there. It only resolves to
              // a path in sandboxes that ship a different pre-installed
              // Chromium and block the download — see scripts/
              // playwright-chromium.ts.
              launchOptions: {
                executablePath: resolveChromiumExecutablePath(),
              },
            }),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
