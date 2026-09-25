import { type ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * Read-only tool that calls the intervals.icu API.
 *
 * `destructiveHint: false` is redundant by the letter of the spec — the field
 * is "meaningful only when readOnlyHint == false" — but it is load-bearing in
 * practice. Its documented default is `true`, so a host that buckets
 * tools with `annotations.destructiveHint ?? true` before it looks at
 * `readOnlyHint` files every read tool under write/delete, and write/delete is
 * the category Claude keeps on "Needs approval" no matter how many times the
 * athlete picks "Allow always". Stating it costs one key and removes the
 * ambiguity for any host that reads the fields in that order.
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Overwrites user data on intervals.icu (e.g. update-activity). */
export const WRITE_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Mutating but convergent: re-running with the same args yields the same state
 * (toggling a star, writing an export file to a deterministic path). */
export const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
