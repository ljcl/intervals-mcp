import { type CallFailure, noteCallFailure } from "../callScope";
import { HttpError, RateLimitError } from "../fetchClient";

/**
 * The one home for tool-facing error text.
 *
 * `handleApiError` (`intervalsClient.ts`) rethrows a 429 as a
 * `RateLimitError` and everything else as `IntervalsApiError extends
 * HttpError`, precisely so a caller can branch on the type or the status.
 * The catch blocks this replaced string-matched `message` for a not-found
 * phrase or "404" instead, which misread any message that happened to
 * contain those characters, could not tell a 402 from a 404 without a
 * second prefix convention, and let an exhausted quota fall into the
 * generic branch as "An unexpected error occurred". Branch here on the
 * typed error only; never on its message.
 *
 * Imports come from `../fetchClient` and `../callScope` only. Tool tests
 * replace the client module with bare factory mocks, so anything imported
 * from there would be `undefined` here and `instanceof undefined` throws
 * inside the very catch block meant to report the failure. `callScope` is a
 * leaf that no test mocks. `IntervalsStreamsUnavailableError` is
 * deliberately not translated for the same reason, and because every stream
 * tool already treats it as a degrade signal in its own success path: it
 * never reaches a tool's outer catch.
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

/** The class logged for a thrown value that is not an `Error`. */
const NON_ERROR_CLASS = "NonError";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The class and HTTP status of a failure, for the call's log line. Reads the
 * type and status only, never the message. Never throws.
 */
export function toolFailureOf(error: unknown): CallFailure {
  try {
    if (!(error instanceof Error)) return { error_class: NON_ERROR_CLASS };
    const failure: CallFailure = {
      error_class: error.constructor.name || "Error",
    };
    if (error instanceof HttpError) failure.http_status = error.response.status;
    return failure;
  } catch {
    return { error_class: NON_ERROR_CLASS };
  }
}

/**
 * Notes `error` as the current call's failure. For a tool branch that returns
 * `isError` without calling {@link toolErrorText}. Never throws.
 */
export function noteToolFailure(error: unknown): void {
  try {
    noteCallFailure(toolFailureOf(error));
  } catch {
    // Telemetry never fails the call it describes.
  }
}

/**
 * `message` with the prefix, for an `isError` text that has no error to
 * translate: the dispatcher's own unknown-tool, invalid-arguments and
 * missing-key texts.
 */
export function prefixedErrorText(message: string): string {
  return `${PREFIX} ${message}`;
}

/**
 * Why an optional read failed, as a clause for a warning: "Heart rate
 * curves not read: <reason>." A tool that degrades on a failed secondary
 * read (and keeps its main answer) words the cause here, so two tools never
 * describe the same failure in two ways. It branches on the typed error
 * like {@link toolErrorText}, never on the message, and never throws. The
 * raw message is the caller's to log for the operator.
 */
export function unavailableReason(error: unknown): string {
  if (error instanceof RateLimitError) {
    return "the intervals.icu rate limit was reached";
  }
  if (error instanceof HttpError && error.response.cloudflareChallenge) {
    return "Cloudflare, in front of intervals.icu, answered with a challenge";
  }
  if (error instanceof HttpError) {
    return `intervals.icu answered HTTP ${error.response.status}`;
  }
  if (error instanceof RequestTimeoutError) {
    return "intervals.icu did not answer in time";
  }
  return "the request failed";
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
  noteToolFailure(error);
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
  // Before the 401/403 branch: a challenge is a 403 that never reached
  // intervals.icu, so "check the API key" would send the athlete to rotate
  // a key that is fine (#52).
  if (error instanceof HttpError && error.response.cloudflareChallenge) {
    return `${PREFIX} Cloudflare, in front of intervals.icu, answered with a challenge (HTTP ${error.response.status}) while trying to ${context}. The request did not reach intervals.icu, so the API key was not checked. Wait a few minutes, then try again.`;
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
