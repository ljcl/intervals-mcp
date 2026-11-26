import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSkillCatalog,
  loadSkillCatalog,
  readSkillFile,
  SKILL_LIMITS,
  SkillCatalogLoadError,
} from "./skills";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function skillMd(name: string, body = "Steps."): string {
  return `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\n${body}\n`;
}

/** Writes `files` (paths relative to `root`), creating folders as needed. */
async function writeFiles(files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

function rootUrl(): URL {
  return pathToFileURL(`${root}/`);
}

describe("buildSkillCatalog", () => {
  it("builds one entry per skill folder, with every file and its digest", async () => {
    await writeFiles({
      "b-skill/SKILL.md": skillMd("b-skill"),
      "a-skill/SKILL.md": skillMd("a-skill"),
      "a-skill/references/guide.md": "# Guide\n",
    });

    const catalog = await buildSkillCatalog(rootUrl());

    expect(catalog.skills.map((s) => s.uri)).toEqual([
      "skill://a-skill/SKILL.md",
      "skill://b-skill/SKILL.md",
    ]);
    const [first] = catalog.skills;
    expect(first?.frontmatter).toMatchObject({
      name: "a-skill",
      description: "Use for a-skill.",
    });
    expect(first?.resources).toEqual([
      {
        uri: "skill://a-skill/SKILL.md",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        size: Buffer.byteLength(skillMd("a-skill")),
      },
      {
        uri: "skill://a-skill/references/guide.md",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        size: 8,
      },
    ]);
    expect(catalog.files.get("skill://a-skill/references/guide.md")).toEqual({
      uri: "skill://a-skill/references/guide.md",
      mimeType: "text/markdown",
      text: "# Guide\n",
    });
  });

  it("serves an empty catalog for an empty folder", async () => {
    const catalog = await buildSkillCatalog(rootUrl());

    expect(catalog.skills).toEqual([]);
    expect(catalog.files.size).toBe(0);
  });

  it.each<[string, Record<string, string | Uint8Array>, RegExp]>([
    [
      "a name that differs from its folder",
      { "my-skill/SKILL.md": skillMd("other-name") },
      /must match the last path segment/,
    ],
    [
      "a missing SKILL.md",
      { "my-skill/notes.md": "# Notes\n" },
      /SKILL\.md is missing/,
    ],
    [
      "frontmatter without a description",
      { "my-skill/SKILL.md": "---\nname: my-skill\n---\n\nSteps.\n" },
      /"name" and "description"/,
    ],
    [
      "a file that is not Markdown",
      {
        "my-skill/SKILL.md": skillMd("my-skill"),
        "my-skill/run.sh": "echo hi\n",
      },
      /only Markdown/,
    ],
    [
      "a file that is not UTF-8",
      {
        "my-skill/SKILL.md": skillMd("my-skill"),
        "my-skill/bad.md": new Uint8Array([0xff, 0xfe, 0xfd]),
      },
      /not valid UTF-8/,
    ],
    [
      "one file over the per-file limit",
      {
        "my-skill/SKILL.md": skillMd(
          "my-skill",
          "x".repeat(SKILL_LIMITS.fileBytes),
        ),
      },
      /limit for one file/,
    ],
    [
      "files that together are over the per-skill limit",
      {
        "my-skill/SKILL.md": skillMd("my-skill"),
        ...Object.fromEntries(
          [1, 2, 3, 4, 5].map((n) => [
            `my-skill/part-${n}.md`,
            "x".repeat(90 * 1024),
          ]),
        ),
      },
      /limit for one skill/,
    ],
    [
      "a file directly in the skills folder",
      { "README.md": "# Skills\n" },
      /must be a skill folder/,
    ],
  ])("refuses %s", async (_label, files, message) => {
    await writeFiles(files);

    const error = await buildSkillCatalog(rootUrl()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SkillCatalogLoadError);
    expect((error as Error).message).toMatch(message);
  });

  it("refuses a symbolic link inside a skill", async () => {
    await writeFiles({ "my-skill/SKILL.md": skillMd("my-skill") });
    await symlink(
      join(root, "my-skill/SKILL.md"),
      join(root, "my-skill/link.md"),
    );

    await expect(buildSkillCatalog(rootUrl())).rejects.toThrow(
      /only plain files and folders/,
    );
  });

  it("refuses more skills than Claude Code loads from one server", async () => {
    await Promise.all(
      Array.from({ length: SKILL_LIMITS.skills + 1 }, (_, i) =>
        mkdir(join(root, `skill-${i}`)),
      ),
    );

    await expect(buildSkillCatalog(rootUrl())).rejects.toThrow(
      /over the limit of 100/,
    );
  });
});

describe("the shipped catalog", () => {
  it("loads, and is read only once", async () => {
    const first = loadSkillCatalog();

    expect(loadSkillCatalog()).toBe(first);
    expect((await first).skills.length).toBeGreaterThan(0);
  });

  it("serves a skill file to a 2026-07-28 request only", async () => {
    const uri = "skill://activity-writes/SKILL.md";

    expect((await readSkillFile(uri, false))?.text).toMatch(
      /^---\nname: activity-writes\n/,
    );
    expect(await readSkillFile(uri, true)).toBeUndefined();
    expect(
      await readSkillFile("ui://activity-chart/app.html", false),
    ).toBeUndefined();
  });
});
