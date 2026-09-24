import { HttpError, RateLimitError } from "../fetchClient";

/**
 * The one home for tool-facing error text.
 *
 * `handleApiError` (`stravaClient.ts`) rethrows a 429 as a `RateLimitError`
 * and everything else as `StravaApiError extends HttpError`, precisely so a
 * caller can branch on the type or the status. The catch blocks this replaced
 * string-matched `message` for Strava's not-found phrase or "404" instead,
 * which misread any message that happened to contain those characters, could not
 * tell a 402 from a 404 without a second prefix convention, and let an
 * exhausted quota fall into the generic branch as "An unexpected error
 * occurred". Branch here on the typed error only; never on its message.
 *
 * Imports come from `../fetchClient` only. Tool tests replace `../stravaClient`
 * with bare factory mocks, so anything imported from there would be
 * `undefined` here and `instanceof undefined` throws inside the very catch
 * block meant to report the failure. `StreamsUnavailableError` is deliberately
 * not translated for the same reason, and because every stream tool already
 * treats it as a degrade signal in its own success path: it never reaches a
 * tool's outer catch.
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
  "This feature requires a Strava subscription. Please check your subscription status.";

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
    return `${PREFIX} Strava rate limit reached while trying to ${context}. ${detail} Retry after the window resets.`;
  }
  if (error instanceof HttpError && error.response.status === 404) {
    return `${PREFIX} ${notFound ?? DEFAULT_NOT_FOUND}`;
  }
  if (error instanceof HttpError && error.response.status === 402) {
    return `${PREFIX} ${DEFAULT_SUBSCRIPTION}`;
  }
  return `${PREFIX} Failed to ${context}: ${message}`;
}
