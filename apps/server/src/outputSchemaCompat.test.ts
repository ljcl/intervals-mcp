/**
 * Output-schema compatibility lock.
 *
 * A host can keep a tool list from before a deploy and validate the new
 * results against the schemas in it. In 2.7.0, get-running-summary dropped
 * the required `weather_temp_c` and added fields to closed objects, and
 * every call from a host that held the 2.6.0 list failed before it returned
 * ("Structured content does not match the tool's output schema").
 *
 * The published output schemas are open now (`toOutputSchema` in
 * server.ts), so a new field is safe. What is still breaking is a change to
 * a field the old schema requires: it goes away, it becomes optional, it
 * takes a type the old schema does not allow (a new `null`, a number where
 * there was an integer), or a new enum value. `output-schema.lock.json`
 * records each required field of each tool's output with its types, one
 * line per field, and this test fails on any such change, naming it.
 *
 * Regenerate after an intended change, and say so in the PR when it removes
 * or widens a line (a host with the old list rejects every result until it
 * reloads the list):
 *   cd apps/server && UPDATE_OUTPUT_SCHEMA_LOCK=1 bunx vitest run src/outputSchemaCompat.test.ts
 * A field that is only added needs the regeneration too, so that its later
 * removal is caught; that diff only adds lines.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "./server";

const LOCK_PATH = new URL("../output-schema.lock.json", import.meta.url);

const LOCK_NOTE =
  "Required fields of every tool's structuredContent, with their types. A host that cached an " +
  "older tool list validates new results against it, so removing a line, or widening its types, " +
  "breaks that host until it reloads the list. See apps/server/src/outputSchemaCompat.test.ts.";

interface LockFile {
  note: string;
  tools: Record<string, string[]>;
}

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
};

/**
 * What a value at this schema may be: its JSON types, plus `=<json>` for
 * each allowed literal when the schema lists them (const or enum).
 */
function tokens(schema: JsonSchema): string[] {
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) return [...new Set(branches.flatMap(tokens))].sort();
  const out = new Set<string>();
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  for (const type of types) out.add(type);
  for (const value of schema.enum ?? []) out.add(`=${JSON.stringify(value)}`);
  if ("const" in schema) out.add(`=${JSON.stringify(schema.const)}`);
  if (out.size === 0) out.add("any");
  return [...out].sort();
}

/**
 * One line per required property, anywhere in the schema: `path: tokens`.
 * Optional properties are walked too, since an old schema checks the
 * required fields inside one whenever it is present. `[]` is an array's
 * items; `|n` the nth object branch of a union with more than one.
 */
function contract(schema: JsonSchema, path: string, lines: string[]): void {
  const branches = (schema.anyOf ?? schema.oneOf ?? [schema]).filter(
    (branch) => branch.properties || branch.items || branch.prefixItems,
  );
  branches.forEach((branch, index) => {
    const at = branches.length > 1 ? `${path}|${index}` : path;
    const required = new Set(branch.required ?? []);
    for (const [key, child] of Object.entries(branch.properties ?? {})) {
      const childPath = at ? `${at}.${key}` : key;
      if (required.has(key)) {
        lines.push(`${childPath}: ${tokens(child).join(" ")}`);
        contract(child, childPath, lines);
      } else {
        contract(child, `${childPath}?`, lines);
      }
    }
    if (branch.items) contract(branch.items, `${at}[]`, lines);
    for (const [i, item] of (branch.prefixItems ?? []).entries()) {
      contract(item, `${at}[${i}]`, lines);
    }
  });
}

function currentContracts(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tool of [...TOOL_DEFS].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!tool.outputSchema) continue;
    const lines: string[] = [];
    contract(tool.outputSchema as JsonSchema, "", lines);
    out[tool.name] = lines.sort();
  }
  return out;
}

function parseLine(line: string): [path: string, tokens: string[]] {
  const at = line.lastIndexOf(": ");
  return [line.slice(0, at), line.slice(at + 2).split(" ")];
}

/**
 * Why a value valid under `now` can fail `locked`, or null when it cannot.
 * An integer is a number, so `integer` now is fine where `number` was.
 */
function widening(locked: string[], now: string[]): string | null {
  const lockedTypes = new Set(locked.filter((t) => !t.startsWith("=")));
  const lockedLiterals = locked.filter((t) => t.startsWith("="));
  if (lockedTypes.has("any")) return null;
  for (const token of now) {
    if (token.startsWith("=")) continue;
    if (lockedTypes.has(token)) continue;
    if (token === "integer" && lockedTypes.has("number")) continue;
    return `can now be ${token}`;
  }
  if (lockedLiterals.length === 0) return null;
  const nowLiterals = now.filter((t) => t.startsWith("="));
  if (nowLiterals.length === 0) return "is no longer limited to its values";
  const added = nowLiterals.filter((t) => !lockedLiterals.includes(t));
  return added.length > 0 ? `can now be ${added.join(", ")}` : null;
}

/** Every change that makes a current result fail a host's locked schema. */
function breakingChanges(
  locked: Record<string, string[]>,
  current: Record<string, string[]>,
): string[] {
  const breaks: string[] = [];
  for (const [tool, lines] of Object.entries(locked)) {
    const now = current[tool];
    if (!now) {
      breaks.push(`${tool}: no longer publishes an outputSchema`);
      continue;
    }
    const nowByPath = new Map(now.map(parseLine));
    for (const line of lines) {
      const [path, lockedTokens] = parseLine(line);
      const nowTokens = nowByPath.get(path);
      if (!nowTokens) {
        breaks.push(`${tool}: ${path} is no longer required (or is gone)`);
        continue;
      }
      const why = widening(lockedTokens, nowTokens);
      if (why) breaks.push(`${tool}: ${path} ${why}`);
    }
  }
  return breaks;
}

describe("output schema compatibility lock", () => {
  const current = currentContracts();

  if (process.env.UPDATE_OUTPUT_SCHEMA_LOCK === "1") {
    it("regenerates output-schema.lock.json", () => {
      const lock: LockFile = { note: LOCK_NOTE, tools: current };
      writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
    });
    return;
  }

  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as LockFile;

  it("keeps every result valid against the locked schemas", () => {
    // Each entry is a change that makes a host holding the old tool list
    // reject every call to that tool. If it is intended, regenerate the lock
    // and name the tools in the PR.
    expect(breakingChanges(lock.tools, current)).toEqual([]);
  });

  it("records the current schemas (regenerate after an additive change)", () => {
    expect(current).toEqual(lock.tools);
  });

  it("names the 2.6.0 break: a required field that went away", () => {
    const locked = { "get-running-summary": ["weather_temp_c: null number"] };
    const now = {
      "get-running-summary": ["weather.temperature_c: null number"],
    };
    expect(breakingChanges(locked, now)).toEqual([
      "get-running-summary: weather_temp_c is no longer required (or is gone)",
    ]);
  });

  it("names a type widening and a new enum value, and allows a narrowing", () => {
    const locked = {
      t: ["a: integer", 'b: ="x" ="y" string', "c: null number", "d: number"],
    };
    const now = {
      t: ["a: integer null", 'b: ="x" ="z" string', "c: number", "d: integer"],
    };
    expect(breakingChanges(locked, now)).toEqual([
      "t: a can now be null",
      't: b can now be ="z"',
    ]);
  });

  it("walks arrays, nullable objects and optional objects", () => {
    const lines: string[] = [];
    contract(
      {
        type: "object",
        properties: {
          laps: {
            type: "array",
            items: {
              type: "object",
              properties: { n: { type: "integer" } },
              required: ["n"],
            },
          },
          weather: {
            anyOf: [
              {
                type: "object",
                properties: { t: { type: "number" } },
                required: ["t"],
              },
              { type: "null" },
            ],
          },
          extra: {
            type: "object",
            properties: { k: { const: "v" } },
            required: ["k"],
          },
        },
        required: ["laps", "weather"],
      },
      "",
      lines,
    );
    expect(lines.sort()).toEqual([
      'extra?.k: ="v"',
      "laps: array",
      "laps[].n: integer",
      "weather.t: number",
      "weather: null object",
    ]);
  });
});
