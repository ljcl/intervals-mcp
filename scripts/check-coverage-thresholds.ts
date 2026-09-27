#!/usr/bin/env bun
/**
 * CI step for #62, run after the Story tests step in ci.yml on pull_request
 * events only. Two checks, both against every vitest config that has (or
 * had, on `origin/main`) a `coverage.thresholds` block:
 *
 * 1. Fails when a committed threshold (this PR's HEAD) is lower than the
 *    same key on `origin/main`, catching a threshold lowered by hand,
 *    since `coverage-ratchet-guard.ts` only guards against vitest's own
 *    auto-update, not a manual edit. A removed key counts as lowered too
 *    (`compareThresholds`). So does any HEAD state where a config that had
 *    thresholds on `origin/main` no longer has a parseable
 *    `coverage.thresholds` block at all, whatever the reason: the property
 *    was deleted, the whole block was emptied or broken, or the config file
 *    itself was deleted or renamed. Escape hatch: the `coverage-lower-ok`
 *    label (checked by the workflow, passed in via
 *    COVERAGE_RATCHET_ESCAPE_HATCH=true) turns the `::error::` annotation
 *    for each lowered finding into `::warning::` and skips the exit-1, so a
 *    green build with the label never gets an error annotation.
 * 2. Warns, without failing, when the working tree (as the Story tests
 *    step just left it) holds a higher threshold than HEAD, the
 *    auto-update fired during this run but the PR has not committed the
 *    raise. In CI that rewrite is discarded when the runner is torn down,
 *    so this is purely a nudge to run `bun run test:coverage` (and
 *    `test:stories:coverage`) locally and commit the update.
 *
 * A config that mentions `thresholds` but fails to parse on `origin/main`
 * itself, or in the working tree for check 2, only gets a `::warning::`:
 * there is nothing to compare against, so it cannot be a confirmed
 * regression.
 *
 * Base ref defaults to `origin/main`; override with COVERAGE_RATCHET_BASE_REF
 * for local testing against a different ref.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareThresholds,
  describeVanishedThresholds,
  mentionsThresholds,
  parseThresholds,
} from "./coverageThresholds";

const CONFIG_PATH_PATTERN = /^(?:apps|packages)\/[^/]+\/vitest\.config\.ts$/;

/** Every vitest config path in the current working tree, found the same way
 * coverage-summary.ts finds each package's coverage output: apps/* and
 * packages/*, plus the root story-test config. */
function discoverConfigPaths(): string[] {
  const paths: string[] = [];
  const rootConfig = "vitest.stories.config.ts";
  if (existsSync(rootConfig)) paths.push(rootConfig);

  for (const group of ["apps", "packages"]) {
    if (!existsSync(group)) continue;
    for (const dir of readdirSync(group).sort()) {
      const configPath = join(group, dir, "vitest.config.ts");
      if (existsSync(configPath)) paths.push(configPath);
    }
  }
  return paths;
}

/** Every matching vitest config path that existed in a given git ref's
 * tree, even one no longer on disk. Needed alongside `discoverConfigPaths`
 * (which only sees the current working tree) so a config deleted or
 * renamed since `ref` is still checked against it, rather than dropping out
 * of the loop entirely. Returns an empty list if `ref` cannot be read. */
function discoverConfigPathsAtRef(ref: string): string[] {
  try {
    const output = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], {
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .filter(
        (path) =>
          path === "vitest.stories.config.ts" || CONFIG_PATH_PATTERN.test(path),
      );
  } catch {
    return [];
  }
}

/** Reads a path's content at a git ref, or null if it does not exist there
 * (a new config with nothing yet to compare against, or one deleted since). */
function readAtRef(ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf-8",
    });
  } catch {
    return null;
  }
}

function main(): void {
  const baseRef = process.env.COVERAGE_RATCHET_BASE_REF ?? "origin/main";
  const escapeHatch = process.env.COVERAGE_RATCHET_ESCAPE_HATCH === "true";
  // A green build (label present) should never carry an ::error:: annotation.
  const loweredLevel = escapeHatch ? "warning" : "error";

  let lowered = false;

  const paths = [
    ...new Set([
      ...discoverConfigPaths(),
      ...discoverConfigPathsAtRef(baseRef),
    ]),
  ].sort();

  for (const path of paths) {
    const headSource = readAtRef("HEAD", path);
    const baseSource = readAtRef(baseRef, path);
    const workingSource = existsSync(path) ? readFileSync(path, "utf-8") : null;

    const headThresholds = headSource ? parseThresholds(headSource) : null;
    const baseThresholds = baseSource ? parseThresholds(baseSource) : null;
    const workingThresholds = workingSource
      ? parseThresholds(workingSource)
      : null;

    if (baseThresholds) {
      if (headThresholds) {
        const { lowered: loweredKeys } = compareThresholds(
          baseThresholds,
          headThresholds,
        );
        if (loweredKeys.length > 0) {
          lowered = true;
          console.log(
            `::${loweredLevel} file=${path}::Coverage threshold(s) lowered vs ${baseRef}: ${loweredKeys.join(", ")}. If intentional, apply the "coverage-lower-ok" label and re-run.`,
          );
        }
      } else {
        // base parses but HEAD does not: a lowering regardless of why, the
        // property was deleted, the block was emptied or broken, or the
        // config file itself was deleted or renamed.
        lowered = true;
        const reason = describeVanishedThresholds(path, headSource);
        console.log(
          `::${loweredLevel} file=${path}::${reason}, versus ${baseRef}. If intentional, apply the "coverage-lower-ok" label and re-run.`,
        );
      }
    } else if (baseSource !== null && mentionsThresholds(baseSource)) {
      console.log(
        `::warning file=${path}::${path} mentions thresholds on ${baseRef} but none parsed there; skipping the lowered-threshold check for this file.`,
      );
    }

    if (headThresholds && workingThresholds) {
      const { raised: raisedKeys } = compareThresholds(
        headThresholds,
        workingThresholds,
      );
      if (raisedKeys.length > 0) {
        console.log(
          `::warning file=${path}::Coverage threshold(s) could rise: ${raisedKeys.join(", ")}. Run \`bun run test:coverage\` locally and commit the update.`,
        );
      }
    } else if (
      headThresholds &&
      !workingThresholds &&
      workingSource !== null &&
      mentionsThresholds(workingSource)
    ) {
      console.log(
        `::warning file=${path}::${path} mentions thresholds in the working tree but none parsed; skipping the uncommitted-raise check for this file.`,
      );
    }
  }

  if (lowered && !escapeHatch) {
    process.exit(1);
  }
  if (lowered && escapeHatch) {
    console.log(
      '"coverage-lower-ok" label present, not failing the build despite the lowered threshold(s) above.',
    );
  }
}

main();
