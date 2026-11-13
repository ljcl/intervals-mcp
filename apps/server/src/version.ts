import { createRequire } from "node:module";

/**
 * Version advertised by the MCP server and /health, sourced from the root
 * package.json that release-please bumps on every release — never hardcoded,
 * which is how an advertised version drifts from the shipped one. Resolved at
 * runtime so dev (workspace) and the Docker runner (pruned tree, root
 * package.json at /app/package.json) both find it.
 */
export const SERVER_VERSION: string = createRequire(import.meta.url)(
  "../../../package.json",
).version;

/**
 * The git commit a value names: 7 to 40 hex digits, lowercased. Anything else
 * (unset, blank, a branch name) is null, so a stray value never reaches
 * /health as if it were a commit.
 */
export function parseCommit(value: string | undefined): string | null {
  const commit = value?.trim().toLowerCase();
  return commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

/**
 * The commit the running image was built from (#414). docker.yml passes it as
 * the `GIT_SHA` build arg, which the Dockerfile's runner stage sets as an
 * environment variable. Null for a local build or a run from a checkout. An
 * `:edge` or `:main-<sha>` image reports the last release as its version, so
 * this is what tells such builds apart.
 */
export const SERVER_COMMIT: string | null = parseCommit(process.env.GIT_SHA);
