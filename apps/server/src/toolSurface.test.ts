/**
 * Tool-identity lock (#303).
 *
 * A host stores the athlete's "Allow always" against a tool's identity, not
 * against the connector as a whole. Rename a tool or reshape its input schema
 * and the stored grant no longer matches what the server advertises, so the
 * next call prompts again — on a self-hosted server that redeploys often, that
 * reads as "Claude keeps forgetting my permissions" with no visible cause.
 *
 * So tool identity is treated as a published contract: `tool-surface.lock.json`
 * records a fingerprint per tool, and any drift fails here naming exactly which
 * existing tools changed. Breaking the contract stays entirely possible — it
 * just has to be a decision someone made on purpose.
 *
 * `description` is deliberately outside the fingerprint. It is model-facing
 * prose that gets reworded often and carries no permission meaning; hashing it
 * would make the lock churn until people regenerated it without reading.
 *
 * Regenerate after an intended change:
 *   cd apps/server && UPDATE_TOOL_SURFACE_LOCK=1 bunx vitest run src/toolSurface.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "./server";

const LOCK_PATH = new URL("../tool-surface.lock.json", import.meta.url);

const LOCK_NOTE =
  "Permission-relevant identity of every advertised tool (#303). Changing an " +
  "entry invalidates the stored 'Allow always' grant for that tool. See " +
  "apps/server/src/toolSurface.test.ts for how to regenerate.";

interface LockFile {
  note: string;
  tools: Record<string, string>;
}

/**
 * JSON with recursively sorted keys, so a fingerprint tracks the schema's
 * content rather than the order zod's JSON Schema emitter happened to build
 * it in. Without this, a zod upgrade that reorders keys would read as 41
 * tools changing identity at once.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function fingerprint(tool: (typeof TOOL_DEFS)[number]): string {
  return createHash("sha256")
    .update(
      stableStringify({
        name: tool.name,
        annotations: tool.annotations ?? null,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        // `_meta.ui.visibility` is permission-adjacent: it is what keeps the
        // app-only data feeds out of the model's tool list.
        meta: tool._meta ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function currentSurface(): Record<string, string> {
  const surface: Record<string, string> = {};
  for (const tool of [...TOOL_DEFS].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    surface[tool.name] = fingerprint(tool);
  }
  return surface;
}

function readLock(): LockFile {
  return JSON.parse(readFileSync(LOCK_PATH, "utf-8")) as LockFile;
}

function writeLock(tools: Record<string, string>): void {
  writeFileSync(
    LOCK_PATH,
    `${JSON.stringify({ note: LOCK_NOTE, tools }, null, 2)}\n`,
  );
}

describe("tool surface lock", () => {
  it("matches the committed lock", () => {
    const current = currentSurface();

    if (process.env.UPDATE_TOOL_SURFACE_LOCK) {
      writeLock(current);
      console.warn(
        "tool-surface.lock.json rewritten — review the diff before committing.",
      );
      return;
    }

    const locked = readLock().tools;
    const changed = Object.keys(locked).filter(
      (name) => name in current && current[name] !== locked[name],
    );
    const added = Object.keys(current).filter((name) => !(name in locked));
    const removed = Object.keys(locked).filter((name) => !(name in current));

    const problems: string[] = [];
    if (changed.length > 0) {
      problems.push(
        `changed identity (every athlete who granted these will be re-prompted): ${changed.join(", ")}`,
      );
    }
    if (added.length > 0) problems.push(`added: ${added.join(", ")}`);
    if (removed.length > 0) problems.push(`removed: ${removed.join(", ")}`);

    expect(
      problems,
      problems.length === 0
        ? ""
        : `Advertised tool surface differs from tool-surface.lock.json.\n` +
            `${problems.join("\n")}\n` +
            `If intended, regenerate: cd apps/server && ` +
            `UPDATE_TOOL_SURFACE_LOCK=1 bunx vitest run src/toolSurface.test.ts`,
    ).toEqual([]);
  });

  it("fingerprints ignore description but track schema and annotations", () => {
    const tool = TOOL_DEFS[0]!;
    const base = fingerprint(tool);

    expect(fingerprint({ ...tool, description: "reworded" })).toBe(base);
    expect(
      fingerprint({ ...tool, annotations: { readOnlyHint: false } }),
    ).not.toBe(base);
    expect(
      fingerprint({ ...tool, inputSchema: { type: "object", properties: {} } }),
    ).not.toBe(base);
    expect(fingerprint({ ...tool, name: `${tool.name}-v2` })).not.toBe(base);
  });

  it("fingerprints are order-independent within a schema", () => {
    const tool = TOOL_DEFS[0]!;

    // Same schema content, keys built in the opposite order.
    const forward = fingerprint({
      ...tool,
      inputSchema: { type: "object", required: ["a"] },
    });
    const reverse = fingerprint({
      ...tool,
      inputSchema: { required: ["a"], type: "object" },
    });

    expect(forward).toBe(reverse);
  });

  it("locks every advertised tool", () => {
    if (process.env.UPDATE_TOOL_SURFACE_LOCK) return;
    expect(Object.keys(readLock().tools).sort()).toEqual(
      TOOL_DEFS.map((t) => t.name).sort(),
    );
  });
});
