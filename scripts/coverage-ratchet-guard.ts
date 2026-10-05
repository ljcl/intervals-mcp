#!/usr/bin/env bun
/**
 * Wraps a `vitest run --coverage` invocation so the coverage threshold
 * ratchet can only rise (#62). vitest's own `thresholds.autoUpdate` rewrite
 * has no access to the previous threshold (see coverageThresholds.ts's
 * doc comment), so it can floor a rewrite anywhere between the current
 * threshold and the configured cushion below the newly measured coverage,
 * silently lowering a committed floor whenever coverage drops by less than
 * the cushion. This script reads the config's thresholds before running the
 * given command, and restores any key the run wrote below that value.
 *
 * Usage: bun scripts/coverage-ratchet-guard.ts <config path> -- <command...>
 * The config path is resolved relative to the current working directory
 * (each package's own vitest.config.ts), matching how the wrapped command
 * itself resolves it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  applyThresholds,
  mentionsThresholds,
  parseThresholds,
  restoreLowered,
} from "./coverageThresholds";

function usageError(message: string): never {
  console.error(`coverage-ratchet-guard: ${message}`);
  console.error(
    "Usage: bun scripts/coverage-ratchet-guard.ts <config path> -- <command...>",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const sepIndex = args.indexOf("--");
if (sepIndex <= 0 || sepIndex === args.length - 1) {
  usageError("expected a config path, `--`, then a command to run");
}

const configPath = args[0];
if (configPath === undefined) {
  usageError("expected a config path, `--`, then a command to run");
}
const command = args.slice(sepIndex + 1);

const beforeSource = readFileSync(configPath, "utf-8");
const before = parseThresholds(beforeSource);
if (!before && mentionsThresholds(beforeSource)) {
  console.warn(
    `::warning file=${configPath}::${configPath} mentions thresholds but they did not parse; the ratchet guard cannot check this config.`,
  );
}

const result = Bun.spawnSync(command, {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

if (before) {
  const afterSource = readFileSync(configPath, "utf-8");
  const after = parseThresholds(afterSource);
  if (after) {
    const restored = restoreLowered(before, after);
    const keys = Object.keys(restored);
    if (keys.length > 0) {
      writeFileSync(
        configPath,
        applyThresholds(afterSource, restored),
        "utf-8",
      );
      console.warn(
        `coverage-ratchet-guard: restored ${keys.join(", ")} in ${configPath}, vitest's autoUpdate would have lowered them below the committed floor.`,
      );
    }
  } else if (mentionsThresholds(afterSource)) {
    console.warn(
      `::warning file=${configPath}::${configPath}'s thresholds no longer parse after this run; the ratchet guard could not check them.`,
    );
  }
}

process.exit(result.exitCode ?? 1);
