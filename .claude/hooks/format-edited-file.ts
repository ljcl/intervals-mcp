/**
 * PostToolUse hook for Write and Edit (.claude/settings.json): formats the one
 * file the tool just changed, and nothing else.
 *
 * Biome runs from the checkout that holds the file: the main checkout, or a
 * `.claude/worktrees/<name>` worktree that an isolated subagent works in. So
 * that checkout's biome.json applies, and its relative excludes (such as
 * `!docs/intervals-openapi.json`) match. The binary is the checkout's pinned
 * Biome, with the main checkout's (argument 1, `$CLAUDE_PROJECT_DIR`) as the
 * fallback for a worktree that has not run `bun install` yet.
 *
 * A formatter must never fail an edit. Anything unexpected (no path, a file
 * outside a git checkout, no Biome, a file Biome skips) ends with exit 0.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const input: unknown = await Bun.stdin.json().catch(() => null);
const file = (input as { tool_input?: { file_path?: unknown } } | null)
  ?.tool_input?.file_path;
if (typeof file !== "string" || !existsSync(file)) process.exit(0);

const toplevel = Bun.spawnSync(
  ["git", "-C", dirname(file), "rev-parse", "--show-toplevel"],
  { stderr: "ignore" },
);
const root = toplevel.success ? toplevel.stdout.toString().trim() : "";
if (!root) process.exit(0);

const biome = [root, process.argv[2]]
  .filter((dir): dir is string => Boolean(dir))
  .map((dir) => join(dir, "node_modules", ".bin", "biome"))
  .find((bin) => existsSync(bin));
if (!biome) process.exit(0);

// --no-errors-on-unmatched: an excluded or git-ignored file is skipped
// quietly. --files-ignore-unknown: so is a file type Biome does not format.
Bun.spawnSync(
  [
    biome,
    "format",
    "--write",
    "--no-errors-on-unmatched",
    "--files-ignore-unknown=true",
    file,
  ],
  { cwd: root, stdout: "ignore", stderr: "ignore" },
);
