/**
 * The runner stage is distroless and assembled entirely by COPY, so a
 * workspace file the server imports but the Dockerfile never copies produces
 * an image that builds perfectly green and then dies on its first line of
 * work:
 *
 *     error: Cannot find module '@intervals-mcp/data' from '/app/apps/server/src/server.ts'
 *
 * That is what #341 shipped. It gave the server its first import of
 * `@intervals-mcp/data` — a JIT package with no build step, whose `exports`
 * points straight at raw TypeScript under `src/` — while the runner only ever
 * copied each MCP App's built `dist/`. `bun install` in the prod-deps stage
 * still creates the `node_modules/@intervals-mcp/data` symlink and `turbo prune`
 * still supplies the package.json, so resolution gets all the way to
 * `./src/index.ts` before discovering the file is not in the image.
 *
 * Neither `docker compose build` nor docker.yml can catch that: both assert
 * the image builds, and the missing file is only resolved at container start.
 * So this guard resolves every `@intervals-mcp/*` specifier the server's runtime
 * sources reference through the target package's own `exports` map, and
 * asserts the file it lands on is inside something the runner copies.
 *
 * It checks the entry point each specifier resolves to. That is sufficient
 * only because the Dockerfile copies *directories* — a package's entry can
 * pull in siblings and they ride along. Narrowing a COPY to a single file
 * would silently outrun this test.
 *
 * The second guard here is about the Bun the image runs rather than what it
 * copies (#359). Root package.json's `packageManager` is the single source of
 * truth: the CI setup action reads it via `bun-version-file`, so it is the
 * Bun that resolves bun.lock. The Dockerfile's `FROM oven/bun:<tag>` lines
 * are the Bun that installs that lockfile and runs the server. Dependabot
 * bumps the base image and never the `packageManager` field, so the two move
 * independently and the lockfile ends up resolved by one Bun and installed by
 * another. A FROM tag cannot be derived from package.json at build time
 * without an ARG threaded through every stage, so the guard pins the tags to
 * `packageManager` instead: a base-image bump goes red until the field moves
 * with it, and the two runtimes stay the same Bun.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Anchored on this file rather than cwd, the way `serverJsonEnv.test.ts` is. */
const SRC_DIR = new URL(".", import.meta.url);
const REPO_ROOT = new URL("../../../", SRC_DIR);
const DOCKERFILE_URL = new URL("../Dockerfile", SRC_DIR);
const ROOT_PACKAGE_JSON_URL = new URL("package.json", REPO_ROOT);

/**
 * Runner COPYs that carry no importable module, with the reason each is
 * there. An exemption without one is just drift with a name.
 */
const NOT_IMPORT_DERIVED: Record<string, string> = {
  "apps/server/src": "the entrypoint itself (CMD runs src/index.ts)",
  "apps/server/scripts": "setup-auth, run by hand against a deployed image",
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * The runner stage's body. Split on `FROM` so an earlier stage's COPY (the
 * builder's `COPY --from=pruner`, say) cannot be mistaken for a runner one.
 */
function runnerStage(): string {
  const dockerfile = readFileSync(DOCKERFILE_URL, "utf8");
  const stage = dockerfile
    .split(/^FROM /m)
    .find((section) => /^\S+\s+AS\s+runner\b/.test(section));
  expect(
    stage,
    "no `FROM ... AS runner` stage in the Dockerfile",
  ).toBeDefined();
  // Fold line continuations so a wrapped COPY parses as one instruction.
  return stage!.replace(/\\\r?\n\s*/g, " ");
}

/**
 * Repo-relative paths the runner copies **from the builder**. Only the builder
 * copies count as content: the prod-deps stage is `turbo prune`'s `out/json`
 * (package.json files only) plus `bun install --production`, so it carries
 * manifests and node_modules and never a package's own sources or build
 * output — which is precisely why a missing COPY resolves far enough to look
 * fine and then fails.
 */
function builderCopies(): string[] {
  const copied: string[] = [];
  for (const match of runnerStage().matchAll(/^COPY\s+(.+)$/gm)) {
    const tokens = match[1]!.trim().split(/\s+/);
    const flags = tokens.filter((token) => token.startsWith("--"));
    const paths = tokens.filter((token) => !token.startsWith("--"));
    if (!flags.includes("--from=builder")) continue;

    const destination = paths.at(-1)!.replace(/^\.\//, "").replace(/\/$/, "");
    for (const source of paths.slice(0, -1)) {
      const relative = source.replace(/^\/app\//, "");
      // The coverage model below assumes the image mirrors the repo layout,
      // because that is what bun resolves against `/app`. A COPY that
      // relocates a package would invalidate it silently.
      expect(
        destination,
        `runner COPY relocates ${relative} to ${destination}`,
      ).toBe(relative);
      copied.push(relative);
    }
  }
  return copied;
}

/** Workspace package name → its repo-relative directory. */
function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(new URL(`${group}/`, REPO_ROOT))) {
      const manifestUrl = new URL(`${group}/${entry}/package.json`, REPO_ROOT);
      let manifest: { name?: string };
      try {
        manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
      } catch {
        continue; // not a package directory
      }
      if (manifest.name) dirs.set(manifest.name, `${group}/${entry}`);
    }
  }
  return dirs;
}

/** Every `@intervals-mcp/*` specifier the server's non-test sources reference. */
function serverSpecifiers(): Map<string, string[]> {
  const specifiers = new Map<string, string[]>();
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    // Tests ride along in the image but never run there.
    .filter((entry) => entry.endsWith(".ts") && !entry.includes(".test."));

  for (const file of files) {
    const source = stripComments(readFileSync(new URL(file, SRC_DIR), "utf8"));
    // Catches static imports and the `createRequire(...).resolve()` calls
    // behind APP_RESOURCES alike — both are string literals, and both have to
    // resolve inside the container.
    for (const match of source.matchAll(/["'](@intervals-mcp\/[^"']+)["']/g)) {
      const specifier = match[1]!;
      const readers = specifiers.get(specifier) ?? [];
      if (!readers.includes(file)) readers.push(file);
      specifiers.set(specifier, readers);
    }
  }
  return specifiers;
}

/** Resolve a specifier to a repo-relative file via the package's `exports`. */
function resolveSpecifier(
  specifier: string,
  dirs: Map<string, string>,
): string {
  const segments = specifier.split("/");
  const name = segments.slice(0, 2).join("/");
  const subpath =
    segments.length > 2 ? `./${segments.slice(2).join("/")}` : ".";

  const dir = dirs.get(name);
  expect(dir, `${specifier} names no workspace package`).toBeDefined();

  const manifest = JSON.parse(
    readFileSync(new URL(`${dir}/package.json`, REPO_ROOT), "utf8"),
  ) as { exports?: string | Record<string, unknown> };

  const target =
    typeof manifest.exports === "string" && subpath === "."
      ? manifest.exports
      : (manifest.exports as Record<string, unknown> | undefined)?.[subpath];

  // Conditional exports would need a resolver this does not have; failing
  // loudly beats quietly declaring an unresolved specifier covered.
  expect(
    typeof target,
    `${name} does not export "${subpath}" as a plain path`,
  ).toBe("string");

  return `${dir}/${(target as string).replace(/^\.\//, "")}`;
}

function isCovered(path: string, copied: string[]): boolean {
  return copied.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

describe("Dockerfile runner stage", () => {
  it("copies every workspace file the server resolves at runtime", () => {
    const copied = builderCopies();
    const dirs = workspaceDirs();
    const specifiers = serverSpecifiers();

    // A broken walk or regex finding nothing must not pass vacuously: the
    // server resolves the seven MCP App bundles plus @intervals-mcp/data.
    expect(specifiers.size).toBeGreaterThanOrEqual(8);
    expect(copied.length).toBeGreaterThanOrEqual(3);

    const missing = [...specifiers.entries()]
      .map(([specifier, readers]) => ({
        specifier,
        readers,
        path: resolveSpecifier(specifier, dirs),
      }))
      .filter(({ path }) => !isCovered(path, copied))
      .map(
        ({ specifier, readers, path }) =>
          `${specifier} -> ${path} (imported by ${readers.join(", ")})`,
      );

    expect(missing).toEqual([]);
  });

  it("copies nothing the server does not resolve", () => {
    const copied = builderCopies();
    const dirs = workspaceDirs();
    const resolved = [...serverSpecifiers().keys()].map((specifier) =>
      resolveSpecifier(specifier, dirs),
    );

    const unused = copied.filter(
      (dir) =>
        !(dir in NOT_IMPORT_DERIVED) &&
        !resolved.some((path) => isCovered(path, [dir])),
    );

    expect(unused).toEqual([]);
  });

  it("keeps the exempt list honest: every exemption is still copied", () => {
    const copied = builderCopies();
    for (const dir of Object.keys(NOT_IMPORT_DERIVED)) {
      expect(
        copied,
        `${dir} is exempt but the runner does not copy it`,
      ).toContain(dir);
    }
  });
});

/**
 * The `packageManager` version. It must be a fully pinned `bun@x.y.z`: a
 * range or a bare `bun` would let CI float while the FROM tags stay fixed,
 * which is the drift this guard exists to stop.
 */
function packageManagerVersion(): string {
  const manifest = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_URL, "utf8")) as {
    packageManager?: unknown;
  };
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(String(manifest.packageManager));
  expect(
    match,
    `root package.json packageManager must be a pinned bun@x.y.z, got ${JSON.stringify(manifest.packageManager)}`,
  ).not.toBeNull();
  return match![1]!;
}

interface BunBaseImage {
  line: number;
  tag: string;
  version: string;
}

/**
 * Every `FROM oven/bun:<tag>` in the Dockerfile, across all stages, with the
 * leading x.y.z of each tag. Tolerates the `-distroless` variant suffix and
 * an `@sha256:...` digest, both of which a Dependabot bump may carry. A tag
 * without a full x.y.z (`1.4`, `latest`) fails outright: it floats, so it can
 * never be equal to a pinned packageManager.
 */
function bunBaseImages(): BunBaseImage[] {
  const images: BunBaseImage[] = [];
  const lines = readFileSync(DOCKERFILE_URL, "utf8").split(/\r?\n/);
  lines.forEach((text, index) => {
    const from = /^FROM\s+(?:--\S+\s+)*oven\/bun:(\S+)/.exec(text);
    if (!from) return;
    const tag = from[1]!;
    const line = index + 1;
    const version = /^(\d+\.\d+\.\d+)(?:-[\w.]+)?(?:@sha256:[0-9a-f]+)?$/.exec(
      tag,
    )?.[1];
    expect(
      version,
      `Dockerfile line ${line}: oven/bun:${tag} carries no pinned x.y.z version`,
    ).toBeDefined();
    images.push({ line, tag, version: version! });
  });
  return images;
}

describe("Dockerfile base image", () => {
  it("runs the Bun that resolved the lockfile (root packageManager)", () => {
    const expected = packageManagerVersion();
    const images = bunBaseImages();

    // A regex miss must not pass vacuously: the Dockerfile has at least the
    // shell base and the distroless runner.
    expect(images.length).toBeGreaterThanOrEqual(2);

    const skewed = images
      .filter(({ version }) => version !== expected)
      .map(
        ({ line, tag, version }) =>
          `Dockerfile line ${line}: FROM oven/bun:${tag} is Bun ${version}, root packageManager is bun@${expected}`,
      );
    expect(skewed).toEqual([]);
  });
});
