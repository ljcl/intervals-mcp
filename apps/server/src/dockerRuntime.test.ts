/**
 * The runner stage is distroless and assembled entirely by COPY, so a
 * workspace file the server imports but the Dockerfile never copies produces
 * an image that builds perfectly green and then dies on its first line of
 * work:
 *
 *     error: Cannot find module '@intervals-mcp/data' from '/app/apps/server/src/server.ts'
 *
 * That is what ljcl/strava-mcp#341 shipped: a JIT workspace import (`@intervals-mcp/data`,
 * raw TypeScript under `src/`) that the runner never copied. The server now
 * runs as one `bun build` bundle (#89), so static imports are inlined at build
 * time and cannot go missing that way. What still resolves at runtime is each
 * `createRequire(...).resolve()` call behind APP_RESOURCES: it walks the
 * workspace symlink and the app's `exports` map to a built `dist/app.html`,
 * all of which the runner has to copy.
 *
 * `docker compose build` cannot catch a missing one: it asserts the image
 * builds, and the file is only resolved at container start. docker.yml's
 * smoke test (scripts/docker-smoke.sh) starts the image, but only in CI. So
 * this guard resolves every runtime-resolved `@intervals-mcp/*` specifier
 * through the target package's own `exports` map, and asserts the file it
 * lands on is inside something the runner copies. It also pins the runner's
 * CMD to the file the builder's `bun build` writes.
 *
 * It checks the entry point each specifier resolves to. That is sufficient
 * only because the Dockerfile copies *directories* — a package's entry can
 * pull in siblings and they ride along. Narrowing a COPY to a single file
 * would silently outrun this test.
 *
 * The second guard here is about the Bun the image runs rather than what it
 * copies (ljcl/strava-mcp#359). Root package.json's `packageManager` is the single source of
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
  "apps/server/dist": "the bundled entrypoint (CMD runs dist/index.js)",
  "apps/server/node_modules/@intervals-mcp":
    "the workspace symlinks each app.html specifier resolves through",
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
 * copies count as content: the pruner copy is `turbo prune`'s `out/json`
 * (package.json files only), so it carries manifests and never a package's
 * own sources or build output — which is precisely why a missing COPY
 * resolves far enough to look fine and then fails.
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

/**
 * Every `@intervals-mcp/*` specifier the server's non-test sources resolve at
 * runtime. Static imports are inlined by the bundle, so only `.resolve()`
 * calls (the ones behind APP_RESOURCES) reach the image's file tree.
 */
function serverSpecifiers(): Map<string, string[]> {
  const specifiers = new Map<string, string[]>();
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    // .dockerignore keeps tests out of the image; skip them here too.
    .filter((entry) => entry.endsWith(".ts") && !entry.includes(".test."));

  for (const file of files) {
    const source = stripComments(readFileSync(new URL(file, SRC_DIR), "utf8"));
    for (const match of source.matchAll(
      /\.resolve\(\s*["'](@intervals-mcp\/[^"']+)["']/g,
    )) {
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
    // server resolves the seven MCP App bundles.
    expect(specifiers.size).toBeGreaterThanOrEqual(7);
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

  it("runs the file the builder bundles", () => {
    const dockerfile = readFileSync(DOCKERFILE_URL, "utf8");
    const outdir =
      /^RUN bun build apps\/server\/src\/index\.ts .*--outdir (\S+)/m.exec(
        dockerfile,
      )?.[1];
    expect(
      outdir,
      "no `bun build apps/server/src/index.ts` in the builder",
    ).toBeDefined();
    expect(runnerStage()).toContain(`CMD ["run","${outdir}/index.js"]`);
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
 * The HEALTHCHECK's exec-form argv. Line continuations are folded first,
 * because the instruction wraps its CMD onto a second line.
 */
function healthcheckArgv(): string[] {
  const dockerfile = readFileSync(DOCKERFILE_URL, "utf8").replace(
    /\\\r?\n\s*/g,
    " ",
  );
  const argv = /^HEALTHCHECK\b.*?\bCMD\s+(\[.*\])\s*$/m.exec(dockerfile)?.[1];
  expect(argv, "no exec-form `HEALTHCHECK ... CMD [...]`").toBeDefined();
  return JSON.parse(argv!) as string[];
}

/**
 * Runs the healthcheck script in-process with a fake `fetch` and `process`.
 * Resolves with the URL it fetched and the code it passed to `exit`.
 */
async function runHealthcheck(
  env: Record<string, string>,
  respond: () => Promise<{ ok: boolean }>,
): Promise<{ url: string | undefined; code: number }> {
  const script = healthcheckArgv()[2]!;
  let url: string | undefined;
  const fakeFetch = (input: string) => {
    url = input;
    return respond();
  };
  const code = await new Promise<number>((exit) => {
    new Function("fetch", "process", script)(fakeFetch, { env, exit });
  });
  return { url, code };
}

describe("Dockerfile healthcheck", () => {
  it("runs a script under the image's bun, with no shell", () => {
    const argv = healthcheckArgv();
    expect(argv.slice(0, 2)).toEqual(["/usr/local/bin/bun", "--eval"]);
    expect(argv).toHaveLength(3);
  });

  // The server reads PORT through getPort() (config.ts): blank or unset
  // means 3000, and surrounding spaces are ignored. The check must agree.
  it.each<[string, Record<string, string>, number]>([
    ["8080", { PORT: "8080" }, 8080],
    ["unset", {}, 3000],
    ["blank", { PORT: "" }, 3000],
    ["padded", { PORT: " 9000 " }, 9000],
  ])(
    "fetches the port the server listens on (PORT %s)",
    async (_label, env, port) => {
      const { url } = await runHealthcheck(env, async () => ({ ok: true }));
      expect(url).toBe(`http://localhost:${port}/health`);
    },
  );

  it("exits 0 for an ok response", async () => {
    const { code } = await runHealthcheck({}, async () => ({ ok: true }));
    expect(code).toBe(0);
  });

  it("exits 1 for a response that is not ok", async () => {
    const { code } = await runHealthcheck({}, async () => ({ ok: false }));
    expect(code).toBe(1);
  });

  it("exits 1 when the fetch fails", async () => {
    const { code } = await runHealthcheck({}, async () => {
      throw new TypeError("fetch failed");
    });
    expect(code).toBe(1);
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

  it("pins every external image by digest, with no floating syntax frontend", () => {
    // A tag can be re-pointed upstream; a digest cannot (#90). Stage names
    // (`FROM base`, `FROM toolchain`) are local and need no pin.
    const dockerfile = readFileSync(DOCKERFILE_URL, "utf8");
    const stages = new Set(
      [...dockerfile.matchAll(/^FROM\s.*\sAS\s+(\S+)/gim)].map((m) => m[1]),
    );
    const unpinned = [...dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)/gm)]
      .map((m) => m[1]!)
      .filter((image) => !stages.has(image))
      .filter((image) => !/@sha256:[0-9a-f]{64}$/.test(image));
    expect(unpinned).toEqual([]);
    expect(dockerfile).not.toMatch(/^#\s*syntax\s*=(?![^\n]*@sha256:)/m);
  });
});

function readToolVersions(): string {
  return readFileSync(new URL(".tool-versions", REPO_ROOT), "utf8");
}

/**
 * The `nodejs` line of .tool-versions, which must be a full x.y.z. CI's setup
 * action installs Node from this file (`node-version-file`), and a major-only
 * `nodejs 24` lets setup-node take whatever 24.x the runner image caches, so
 * an image update would change the Node that runs vitest, vite, knip and
 * Storybook without a commit (#87).
 */
function toolVersionsNode(): string {
  const pinned = /^nodejs\s+(\S+)\s*$/m.exec(readToolVersions())?.[1];
  expect(
    pinned,
    `.tool-versions nodejs must be a pinned x.y.z, got ${JSON.stringify(pinned)}`,
  ).toMatch(/^\d+\.\d+\.\d+$/);
  return pinned!;
}

describe("local toolchain pin", () => {
  it("pins .tool-versions to the same Bun as root packageManager", () => {
    // mise/asdf read .tool-versions. A loose `bun 1` resolves to whatever
    // 1.x is already installed, so a local `bun install` can rewrite
    // bun.lock with a different Bun than CI and the image use.
    const pinned = /^bun\s+(\S+)\s*$/m.exec(readToolVersions())?.[1];
    expect(pinned).toBe(packageManagerVersion());
  });

  it("installs the .tool-versions Node in CI", () => {
    // Asserts the line is a full x.y.z; the setup action reads it as-is.
    toolVersionsNode();
    const action = readFileSync(
      new URL(".github/actions/setup/action.yml", REPO_ROOT),
      "utf8",
    );
    expect(action).toMatch(/^\s*node-version-file:\s*\.tool-versions\s*$/m);
  });

  it("builds the MCP Apps in the image with the .tool-versions Node", () => {
    // The builder copies `node` from this stage so Vite runs under the same
    // Node as CI's build and tests, not under the base image's bun fallback.
    // Same drift as the Bun pin above: Dependabot bumps this tag and never
    // .tool-versions.
    const expected = toolVersionsNode();
    const dockerfile = readFileSync(DOCKERFILE_URL, "utf8");
    const tag = /^FROM\s+(?:--\S+\s+)*node:(\S+)\s+AS\s+node\b/m.exec(
      dockerfile,
    )?.[1];
    expect(tag, "no `FROM node:<tag> AS node` stage").toBeDefined();
    // Tolerates variant suffixes (`-trixie-slim`) and a digest.
    const version = /^(\d+\.\d+\.\d+)(?:-[\w.-]+)?(?:@sha256:[0-9a-f]+)?$/.exec(
      tag!,
    )?.[1];
    expect(version, `node:${tag} carries no pinned x.y.z version`).toBe(
      expected,
    );
    expect(dockerfile).toMatch(
      /^COPY --from=node \/usr\/local\/bin\/node \/usr\/local\/bin\/node$/m,
    );
  });
});
