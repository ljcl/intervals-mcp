import { HttpError, NotPortedError, RateLimitError } from "../fetchClient";

/**
 * The one home for tool-facing error text.
 *
 * `handleApiError` (stravaClient.ts) rethrows a 429 as a `RateLimitError`,
 * a 401 (every call, since that client sends no Authorization header on
 * purpose) as `NotPortedError`, and everything else as `StravaApiError extends
 * HttpError`, precisely so a caller can branch on the type or the status. The
 * catch blocks this replaced string-matched `message` for Strava's not-found
 * phrase or "404" instead, which misread any message that happened to
 * contain those characters, could not tell a 402 from a 404 without a second
 * prefix convention, and let an exhausted quota fall into the generic branch
 * as "An unexpected error occurred". Branch here on the typed error only;
 * never on its message.
 *
 * `NotPortedError` is checked before the generic 401/403 branch below, even
 * though it is itself an `HttpError` with status 401: without that ordering
 * every unported tool's "not yet ported" message would be swallowed by the
 * 401/403 branch's "intervals.icu rejected the API key" text, which is wrong:
 * that 401 comes from stravaClient.ts sending no Authorization
 * header on purpose, not from intervals.icu rejecting a real key.
 *
 * Imports come from `../fetchClient` only (including `NotPortedError`, which
 * lives there rather than in stravaClient.ts for this reason). Tool
 * tests replace that module with bare factory mocks, so anything imported
 * from there would be `undefined` here and `instanceof undefined` throws
 * inside the very catch block meant to report the failure.
 * `StreamsUnavailableError` is deliberately not translated for the same
 * reason, and because every stream tool already treats it as a degrade
 * signal in its own success path: it never reaches a tool's outer catch.
 *
 * This produces the text, not the `{ content, isError }` result, on purpose.
 * A tool's catch block writes that literal itself, as every other branch in
 * the file does: TypeScript widens a handler's inferred return union by
 * giving each fresh object literal its siblings' missing properties as
 * optional `undefined`, which is what lets a test read `result.isError` on
 * the success branch. A named result type in that union gets no such
 * treatment (nor does a literal that spreads one), and every `result.isError`
 * in the tool's tests becomes a type error.
 */

export interface ToolErrorOptions {
  /**
   * Verb phrase naming what the tool was doing ("fetch activity 789", "list
   * recent activities"), read as "while trying to <context>" and
   * "Failed to <context>".
   */
  context: string;
  /** Sentence to show on a 404. Defaults to a generic "Not found." */
  notFound?: string;
}

const DEFAULT_NOT_FOUND = "Not found.";
const DEFAULT_SUBSCRIPTION =
  "This feature requires a paid subscription. Please check your subscription status.";

/** The prefix every `isError` text on the surface starts with. */
const PREFIX = "❌";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Builds the `isError` text for a failure that escaped a tool's success
 * path. Never throws: a `null`, `undefined`, or non-`Error` input still
 * yields a prefixed line, because a catch block that itself throws turns a
 * reportable failure into a JSON-RPC error the host cannot show.
 */
export function toolErrorText(
  error: unknown,
  options: ToolErrorOptions,
): string {
  const { context, notFound } = options;
  const message = messageOf(error);
  // Operator logs keep the raw detail the athlete-facing line may not carry.
  console.error(`Error while trying to ${context}: ${message}`);

  if (error instanceof RateLimitError) {
    // `detail` is the bare window description; `message` carries the client
    // function's name in front of it, which means nothing to the athlete.
    const detail = error.detail || error.message;
    return `${PREFIX} Rate limit reached while trying to ${context}. ${detail} Retry after the window resets.`;
  }
  if (error instanceof NotPortedError) {
    // Checked before the 401/403 branch below: NotPortedError is an
    // HttpError with status 401 (stravaClient.ts sends no
    // Authorization header on purpose), and that 401 means "not yet ported to
    // intervals.icu", not "intervals.icu rejected the API key". Its own
    // message already says so; nothing to add.
    return `${PREFIX} ${error.message}`;
  }
  if (error instanceof HttpError && error.response.status === 404) {
    return `${PREFIX} ${notFound ?? DEFAULT_NOT_FOUND}`;
  }
  if (error instanceof HttpError && error.response.status === 402) {
    return `${PREFIX} ${DEFAULT_SUBSCRIPTION}`;
  }
  if (
    error instanceof HttpError &&
    (error.response.status === 401 || error.response.status === 403)
  ) {
    return `${PREFIX} intervals.icu rejected the API key (HTTP ${error.response.status}). Check INTERVALS_API_KEY.`;
  }
  return `${PREFIX} Failed to ${context}: ${message}`;
}
