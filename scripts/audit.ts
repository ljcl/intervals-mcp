#!/usr/bin/env bun
/**
 * The dependency audit gate. ci.yml's `audit` job runs it (a hard gate on the
 * weekly schedule, advisory on PRs and main pushes); `bun run audit` runs the
 * same check locally.
 *
 * It runs `bun audit --audit-level=high` and skips the advisories in
 * AUDIT_IGNORES. An advisory goes on that list only when no published version
 * fixes it (`bun audit fix` reports it as unfixable) and its vulnerable code
 * cannot be reached here; the entry says why. Without the list, one such
 * advisory kept the weekly run red for weeks, and a gate that is always red
 * hides the next real finding.
 *
 * An ignore must not outlive its reason, so the gate also reads
 * `bun audit fix --dry-run --json`. When an ignored advisory is no longer in
 * that plan's `unfixable` list (a fixed version shipped, or the package left
 * the lockfile), the gate fails and says to run `bun audit fix` and delete the
 * entry. See docs/development.md#clearing-a-bun-audit-failure.
 */
import { spawnSync } from "node:child_process";

export interface AuditIgnore {
  /** GHSA id: the form `bun audit --ignore` matches (CVE ids do not). */
  id: string;
  /** The package the advisory names, for the log line. */
  package: string;
  /** Why the vulnerable code cannot be reached in this repo. */
  reason: string;
}

export const AUDIT_IGNORES: readonly AuditIgnore[] = [];

/** The part of `bun audit fix --dry-run --json` this gate reads. */
export interface AuditFixPlan {
  unfixable?: { name: string; advisories: string[] }[];
}

/** The ignores whose advisory the fix plan no longer lists as unfixable. */
export function staleIgnores(
  ignores: readonly AuditIgnore[],
  plan: AuditFixPlan,
): AuditIgnore[] {
  const unfixable = new Set(
    (plan.unfixable ?? []).flatMap((entry) => entry.advisories),
  );
  return ignores.filter((ignore) => !unfixable.has(ignore.id));
}

function main(): number {
  for (const ignore of AUDIT_IGNORES) {
    console.log(`Ignoring ${ignore.id} (${ignore.package}): ${ignore.reason}`);
  }

  const audit = spawnSync(
    process.execPath,
    [
      "audit",
      "--audit-level=high",
      ...AUDIT_IGNORES.map((ignore) => `--ignore=${ignore.id}`),
    ],
    { stdio: "inherit" },
  );
  if (AUDIT_IGNORES.length === 0) return audit.status ?? 1;

  // Exits 1 whenever any advisory remains, the ignored ones included, so
  // only the JSON on stdout counts.
  const fix = spawnSync(
    process.execPath,
    ["audit", "fix", "--dry-run", "--json"],
    { encoding: "utf-8" },
  );
  let plan: AuditFixPlan;
  try {
    plan = JSON.parse(fix.stdout) as AuditFixPlan;
  } catch {
    console.log(
      "Could not read the `bun audit fix --dry-run --json` plan, so the " +
        "ignore list is unchecked.",
    );
    console.log(fix.stderr);
    return 1;
  }

  const stale = staleIgnores(AUDIT_IGNORES, plan);
  for (const ignore of stale) {
    console.log(
      `${ignore.id} (${ignore.package}) is ignored, but \`bun audit fix\` no ` +
        "longer lists it as unfixable. Run `bun audit fix`, then delete its " +
        "AUDIT_IGNORES entry in scripts/audit.ts.",
    );
  }
  return audit.status === 0 && stale.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
