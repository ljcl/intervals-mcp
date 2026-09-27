/**
 * Unit tests for the pure comparison logic in coverageThresholds.ts (#62).
 * No existing script has a test home, so this runs on Bun's built-in test
 * runner (`bun test scripts`) rather than adding a vitest config for a
 * single file at root; see AGENTS.md / docs/development.md for why a
 * default-named root vitest.config.ts is avoided.
 */
import { describe, expect, test } from "bun:test";
import {
  applyThresholds,
  compareThresholds,
  describeVanishedThresholds,
  mentionsThresholds,
  parseThresholds,
  restoreLowered,
} from "./coverageThresholds";

const SAMPLE_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: {
        autoUpdate: (newThreshold: number) => Math.floor(newThreshold - 5),
        statements: 91,
        branches: 80,
        functions: 93,
        lines: 92,
      },
    },
  },
});
`;

describe("parseThresholds", () => {
  test("extracts all four keys from a config's thresholds block", () => {
    expect(parseThresholds(SAMPLE_CONFIG)).toEqual({
      statements: 91,
      branches: 80,
      functions: 93,
      lines: 92,
    });
  });

  test("returns null when there is no thresholds block", () => {
    expect(parseThresholds("export default {}")).toBeNull();
  });

  test("ignores keys outside the thresholds block", () => {
    const source = `
      const statements = 999;
      export default {
        test: { coverage: { thresholds: { branches: 80 } } },
      };
    `;
    expect(parseThresholds(source)).toEqual({ branches: 80 });
  });
});

describe("mentionsThresholds", () => {
  test("is true when a thresholds key appears, even if it does not parse", () => {
    expect(mentionsThresholds("coverage: { thresholds: {} }")).toBe(true);
  });

  test("is false when there is no thresholds key at all", () => {
    expect(mentionsThresholds("export default {}")).toBe(false);
  });
});

describe("describeVanishedThresholds", () => {
  test("reports a deleted or renamed config file when HEAD has no source at all", () => {
    expect(
      describeVanishedThresholds("apps/server/vitest.config.ts", null),
    ).toBe(
      "apps/server/vitest.config.ts no longer exists at HEAD (deleted or renamed)",
    );
  });

  test("reports a removed gate when the whole thresholds property is gone", () => {
    const headSource = `export default { test: { coverage: { provider: "v8" } } };`;
    expect(
      describeVanishedThresholds("apps/server/vitest.config.ts", headSource),
    ).toBe(
      "apps/server/vitest.config.ts's coverage.thresholds gate was removed",
    );
  });

  test("reports an unparseable block when thresholds is mentioned but emptied", () => {
    const headSource = `export default { test: { coverage: { thresholds: {} } } };`;
    expect(
      describeVanishedThresholds("apps/server/vitest.config.ts", headSource),
    ).toBe(
      "apps/server/vitest.config.ts mentions thresholds but none parsed at HEAD",
    );
  });
});

describe("applyThresholds", () => {
  test("rewrites only the given keys, in place", () => {
    const updated = applyThresholds(SAMPLE_CONFIG, {
      statements: 91,
      branches: 85,
    });
    expect(parseThresholds(updated)).toEqual({
      statements: 91,
      branches: 85,
      functions: 93,
      lines: 92,
    });
  });

  test("is a no-op when there is no thresholds block", () => {
    const source = "export default {}";
    expect(applyThresholds(source, { statements: 91 })).toBe(source);
  });
});

describe("compareThresholds", () => {
  test("reports a lowered key", () => {
    const result = compareThresholds({ statements: 91 }, { statements: 88 });
    expect(result).toEqual({ lowered: ["statements"], raised: [] });
  });

  test("reports a raised key", () => {
    const result = compareThresholds({ statements: 91 }, { statements: 96 });
    expect(result).toEqual({ lowered: [], raised: ["statements"] });
  });

  test("ignores an unchanged key", () => {
    const result = compareThresholds({ statements: 91 }, { statements: 91 });
    expect(result).toEqual({ lowered: [], raised: [] });
  });

  test("skips a key missing from base (a newly added threshold)", () => {
    const result = compareThresholds(
      { branches: 80 },
      { branches: 80, statements: 96 },
    );
    expect(result).toEqual({ lowered: [], raised: [] });
  });

  test("treats a key present in base but missing from next as lowered", () => {
    const result = compareThresholds(
      { statements: 91, branches: 80 },
      { statements: 91 },
    );
    expect(result).toEqual({ lowered: ["branches"], raised: [] });
  });

  test("evaluates every key independently in one call", () => {
    const result = compareThresholds(
      { statements: 91, branches: 80, functions: 93, lines: 92 },
      { statements: 88, branches: 85, functions: 93, lines: 92 },
    );
    expect(result).toEqual({ lowered: ["statements"], raised: ["branches"] });
  });
});

describe("restoreLowered", () => {
  test("restores a key vitest's autoUpdate wrote below its prior value", () => {
    // apps/server/vitest.config.ts's exact bug (#62): coverage measured at
    // 93% (above the 91 floor, so autoUpdate fires) but the cushion floors
    // it at 88, below the committed value.
    const before = { statements: 91 };
    const after = { statements: 88 };
    expect(restoreLowered(before, after)).toEqual({ statements: 91 });
  });

  test("returns nothing when the run only raised or left thresholds alone", () => {
    const before = { statements: 91, branches: 80 };
    const after = { statements: 96, branches: 80 };
    expect(restoreLowered(before, after)).toEqual({});
  });

  test("handles several keys moving in different directions at once", () => {
    const before = { statements: 91, branches: 80, functions: 93, lines: 92 };
    const after = { statements: 88, branches: 85, functions: 93, lines: 87 };
    expect(restoreLowered(before, after)).toEqual({
      statements: 91,
      lines: 92,
    });
  });
});

describe("guard round trip", () => {
  test("restoring a lowered rewrite through applyThresholds never leaves a key below its prior value", () => {
    const before = parseThresholds(SAMPLE_CONFIG);
    if (!before) throw new Error("expected SAMPLE_CONFIG to have thresholds");

    // Simulate vitest's own rewrite landing below the committed floor.
    const rewritten = applyThresholds(SAMPLE_CONFIG, { statements: 88 });
    const after = parseThresholds(rewritten);
    if (!after) throw new Error("expected rewritten config to have thresholds");

    const restored = restoreLowered(before, after);
    const repaired = applyThresholds(rewritten, restored);
    const repairedThresholds = parseThresholds(repaired);
    if (!repairedThresholds) {
      throw new Error("expected repaired config to have thresholds");
    }

    expect(compareThresholds(before, repairedThresholds).lowered).toEqual([]);
  });
});
