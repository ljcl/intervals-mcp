/**
 * `server.json` is what the MCP registry publishes as the run instructions
 * for the OCI package, so a variable missing from its `environmentVariables`
 * block is invisible to anyone deploying from the registry. `MCP_AUTH_TOKEN`
 * was missing for exactly that reason until #336 — the one knob protecting an
 * endpoint carrying the athlete's data and the write tools.
 *
 * This guard (#337) compares the manifest against the variables the server
 * actually reads, in both directions: a read with no manifest entry is a
 * deploy-time knob nobody deploying from the registry can discover, and a
 * manifest entry nothing reads is documentation for a knob that does nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Anchored on this file rather than cwd, the way `envScaffolding.test.ts` is. */
const SRC_DIR = new URL(".", import.meta.url);
const SERVER_JSON_URL = new URL("../../../server.json", SRC_DIR);

/**
 * Variables the server reads that are deliberately absent from the manifest.
 * Each entry needs a reason — an exemption without one is just drift with
 * a name.
 */
const EXEMPT: Record<string, string> = {
  // Dev/test-only: gates warnOnSchemaDrift (tools/outputs.ts) off in
  // production; never something a deployer sets to configure the server.
  NODE_ENV: "dev/test-only schema-drift gate",
  // Dev-only: regenerates tool-surface.lock.json inside toolSurface.test.ts;
  // meaningless outside a test run.
  UPDATE_TOOL_SURFACE_LOCK: "dev-only lock regeneration flag",
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts"));
}

/** Every `process.env.X` read under src/, with the files that read it. */
function envReads(): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const source = stripComments(readFileSync(new URL(file, SRC_DIR), "utf8"));
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      const name = match[1]!;
      const files = reads.get(name) ?? [];
      if (!files.includes(file)) files.push(file);
      reads.set(name, files);
    }
  }
  return reads;
}

function manifestVariables(): string[] {
  const manifest = JSON.parse(readFileSync(SERVER_JSON_URL, "utf8")) as {
    packages?: Array<{
      environmentVariables?: Array<{ name: string }>;
    }>;
  };
  const names = (manifest.packages ?? []).flatMap((pkg) =>
    (pkg.environmentVariables ?? []).map((variable) => variable.name),
  );
  expect(names.length).toBeGreaterThan(0);
  return names;
}

describe("server.json environmentVariables", () => {
  it("lists every variable the server reads (or the read is exempt, with a reason)", () => {
    const reads = envReads();
    // A broken walk or regex finding nothing must not pass vacuously: the
    // server reads at least the intervals.icu credentials, the auth token,
    // and the port.
    expect(reads.size).toBeGreaterThanOrEqual(8);

    const documented = new Set(manifestVariables());
    const undocumented = [...reads.entries()]
      .filter(([name]) => !documented.has(name) && !(name in EXEMPT))
      .map(([name, files]) => `${name} (read by ${files.join(", ")})`);

    expect(undocumented).toEqual([]);
  });

  it("lists nothing the server does not read", () => {
    const reads = envReads();
    const unread = manifestVariables().filter((name) => !reads.has(name));
    expect(unread).toEqual([]);
  });

  it("keeps the exempt list honest: every exemption is still read and still undocumented", () => {
    const reads = envReads();
    const documented = new Set(manifestVariables());
    for (const name of Object.keys(EXEMPT)) {
      expect(reads.has(name), `${name} is exempt but nothing reads it`).toBe(
        true,
      );
      expect(
        documented.has(name),
        `${name} is exempt but server.json documents it`,
      ).toBe(false);
    }
  });
});
