/**
 * Skills over MCP: the `io.modelcontextprotocol/skills` extension (SEP-2640,
 * #527).
 *
 * A skill is a folder under `apps/server/skills/` with a `SKILL.md` (YAML
 * frontmatter `name` and `description`, then the instructions) and optional
 * Markdown references beside it. A host lists the skills with `skills/list`,
 * loads one only when the task needs it, and reads its files with
 * `resources/read`. So the long-form guidance costs no context until it is
 * used, and it updates with each deploy.
 *
 * The SDK's `SkillsExtension.attach()` wires the extension onto an
 * `McpServer`. `createServer` builds the low-level `Server` and owns
 * `resources/read` for the app resources and the route exports, so this
 * module builds the entries with the SDK's `skillEntry` (digests, sizes,
 * frontmatter and name checks) and `registerSkills` sets the two methods
 * itself. The catalog is read from disk once, at startup (`index.ts`), and
 * held in memory: `createServer` runs per request.
 *
 * Skills need the 2026-07-28 revision. `registerSkills` runs only for that
 * era, and `readSkillFile` serves nothing to a 2025-era request.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProtocolError,
  ProtocolErrorCode,
  type Server,
} from "@modelcontextprotocol/server";
import {
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
  type Skill,
  skillEntry,
} from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";

/**
 * The folder that holds one folder per skill. `src/skills.ts` and the
 * bundled `dist/index.js` both sit one level below `apps/server`, so the same
 * relative URL finds it in development, in tests and in the image.
 */
export const SKILLS_DIR = new URL("../skills/", import.meta.url);

/** Every URI this server serves a skill file at starts with this. */
const SKILL_URI_PREFIX = "skill://";

/**
 * Claude Code's limits on a skill from an MCP server, which are tighter than
 * the spec's (512 files, 16 MiB per skill). A skill over one of them does not
 * load there, so the catalog refuses it at startup instead.
 */
export const SKILL_LIMITS = {
  skills: 100,
  fileBytes: 100 * 1024,
  skillBytes: 400 * 1024,
} as const;

/** The only file type a skill here holds. */
const SKILL_FILE_MIME_TYPE = "text/markdown";

interface SkillFile {
  uri: string;
  mimeType: typeof SKILL_FILE_MIME_TYPE;
  text: string;
}

export interface SkillCatalog {
  /** The `skills/list` entries, sorted by URI. */
  skills: readonly Skill[];
  /** Every skill file, by URI. */
  files: ReadonlyMap<string, SkillFile>;
}

/** A skill folder that breaks a rule. Startup stops on it. */
export class SkillCatalogLoadError extends Error {
  constructor(path: string, problem: string) {
    super(`Skill ${path}: ${problem}`);
    this.name = "SkillCatalogLoadError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Every file under `dir`, as `/`-separated paths relative to it. */
async function skillFilePaths(dir: URL, skill: string): Promise<string[]> {
  const base = fileURLToPath(dir);
  const entries = await readdir(base, { withFileTypes: true, recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = relative(base, join(entry.parentPath, entry.name))
      .split(sep)
      .join("/");
    if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) {
      throw new SkillCatalogLoadError(
        `${skill}/${path}`,
        "only plain files and folders are allowed",
      );
    }
    if (entry.isFile()) paths.push(path);
  }
  return paths.sort();
}

/** Reads one skill folder and builds its entry. */
async function loadSkill(
  root: URL,
  name: string,
): Promise<{ skill: Skill; files: SkillFile[] }> {
  const dir = new URL(`${name}/`, root);
  const contents: Record<string, string> = {};
  let total = 0;
  for (const path of await skillFilePaths(dir, name)) {
    if (!path.endsWith(".md")) {
      throw new SkillCatalogLoadError(
        `${name}/${path}`,
        "only Markdown (.md) files are allowed",
      );
    }
    const bytes = await readFile(new URL(path, dir));
    if (bytes.byteLength > SKILL_LIMITS.fileBytes) {
      throw new SkillCatalogLoadError(
        `${name}/${path}`,
        `${bytes.byteLength} bytes is over the ${SKILL_LIMITS.fileBytes}-byte limit for one file`,
      );
    }
    total += bytes.byteLength;
    try {
      contents[path] = utf8.decode(bytes);
    } catch {
      throw new SkillCatalogLoadError(`${name}/${path}`, "is not valid UTF-8");
    }
  }
  if (total > SKILL_LIMITS.skillBytes) {
    throw new SkillCatalogLoadError(
      name,
      `${total} bytes is over the ${SKILL_LIMITS.skillBytes}-byte limit for one skill`,
    );
  }
  let skill: Skill;
  try {
    skill = await skillEntry(name, contents, { baseUri: SKILL_URI_PREFIX });
  } catch (error) {
    const problems = (error as { problems?: { message: string }[] }).problems;
    throw new SkillCatalogLoadError(
      name,
      problems?.map((p) => p.message).join("; ") ?? String(error),
    );
  }
  const files = Object.entries(contents).map(
    ([path, text]): SkillFile => ({
      uri: `${SKILL_URI_PREFIX}${name}/${path}`,
      mimeType: SKILL_FILE_MIME_TYPE,
      text,
    }),
  );
  return { skill, files };
}

/** Reads every skill folder under `root`. Throws on the first rule broken. */
export async function buildSkillCatalog(root: URL): Promise<SkillCatalog> {
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new SkillCatalogLoadError(
        entry.name,
        "each entry in the skills folder must be a skill folder",
      );
    }
    names.push(entry.name);
  }
  if (names.length > SKILL_LIMITS.skills) {
    throw new SkillCatalogLoadError(
      root.pathname,
      `${names.length} skills is over the limit of ${SKILL_LIMITS.skills}`,
    );
  }
  const skills: Skill[] = [];
  const files = new Map<string, SkillFile>();
  for (const name of names.sort()) {
    const loaded = await loadSkill(root, name);
    skills.push(loaded.skill);
    for (const file of loaded.files) files.set(file.uri, file);
  }
  skills.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return { skills, files };
}

let catalog: Promise<SkillCatalog> | undefined;

/**
 * The shipped catalog, read once. Startup awaits it, so a broken skill stops
 * the server before it listens rather than failing a host's first read.
 */
export function loadSkillCatalog(): Promise<SkillCatalog> {
  catalog ??= buildSkillCatalog(SKILLS_DIR);
  return catalog;
}

/**
 * A skill file for `resources/read`, or `undefined` when `uri` is not one.
 * A 2025-era request gets nothing: skills need the 2026-07-28 revision.
 */
export async function readSkillFile(
  uri: string,
  legacy: boolean,
): Promise<SkillFile | undefined> {
  if (legacy || !uri.startsWith(SKILL_URI_PREFIX)) return undefined;
  return (await loadSkillCatalog()).files.get(uri);
}

const listParams = z.object({ cursor: z.string().optional() });
const getParams = z.object({ uri: z.string() });

/** A JSON-RPC Invalid Params error (`-32602`), as the spec asks for an unknown skill. */
function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

/**
 * Declares the extension and serves `skills/list` and `skills/get` on one
 * 2026-07-28 server. Every skill fits on one page, so a cursor is never
 * issued and any cursor sent is refused. `cache` is the result's `ttlMs` and
 * `cacheScope`, the same hint as the other static surfaces.
 */
export function registerSkills(
  server: Server,
  cache: { ttlMs: number; cacheScope: "private" },
): void {
  server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
  server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: listParams },
    async (params) => {
      if (params.cursor !== undefined) {
        throw invalidParams(`Unknown cursor: ${params.cursor}`);
      }
      const { skills } = await loadSkillCatalog();
      return { skills: [...skills], ...cache };
    },
  );
  server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: getParams },
    async (params) => {
      const { skills } = await loadSkillCatalog();
      const skill = skills.find((entry) => entry.uri === params.uri);
      if (!skill) throw invalidParams(`No skill is served at ${params.uri}`);
      return { skill, ...cache };
    },
  );
}
