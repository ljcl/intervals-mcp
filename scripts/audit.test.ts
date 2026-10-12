/**
 * Unit tests for the stale-ignore check in audit.ts. Runs on Bun's test
 * runner (`bun test scripts`), like coverageThresholds.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { AUDIT_IGNORES, type AuditIgnore, staleIgnores } from "./audit";

const BRACES: AuditIgnore = {
  id: "GHSA-vfj7-8cjw-p6xm",
  package: "braces",
  reason: "test",
};

describe("staleIgnores", () => {
  test("keeps an ignore while the plan still lists it as unfixable", () => {
    const plan = {
      unfixable: [{ name: "braces", advisories: ["GHSA-vfj7-8cjw-p6xm"] }],
    };
    expect(staleIgnores([BRACES], plan)).toEqual([]);
  });

  test("flags an ignore once a fix exists", () => {
    // A fixed version moves the package from `unfixable` to `fixes`.
    const plan = { unfixable: [] };
    expect(staleIgnores([BRACES], plan)).toEqual([BRACES]);
  });

  test("flags an ignore when the plan has no unfixable list at all", () => {
    expect(staleIgnores([BRACES], {})).toEqual([BRACES]);
  });

  test("matches the advisory id, not the package name", () => {
    const plan = {
      unfixable: [{ name: "braces", advisories: ["GHSA-0000-0000-0000"] }],
    };
    expect(staleIgnores([BRACES], plan)).toEqual([BRACES]);
  });
});

describe("AUDIT_IGNORES", () => {
  test("every entry is a GHSA id with a reason", () => {
    for (const ignore of AUDIT_IGNORES) {
      expect(ignore.id).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      expect(ignore.reason.length).toBeGreaterThan(0);
    }
  });

  test("lists each advisory once", () => {
    const ids = AUDIT_IGNORES.map((ignore) => ignore.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
