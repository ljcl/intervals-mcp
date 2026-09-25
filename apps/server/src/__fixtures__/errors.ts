import { HttpError, RateLimitError } from "../fetchClient";

/**
 * The rate-limit error an intervals.icu client call actually throws.
 *
 * Every client function funnels its failures through `handleApiError`, which
 * rethrows a 429 with the context prefixed onto the message. A tool test that
 * rejects with a raw `RateLimitError` straight off the fetch layer is mocking a
 * shape production cannot produce — which is how the scan tools' rate-limit
 * abort passed its tests while being dead in the server (the client used to
 * flatten the error into a plain `Error`, so `instanceof RateLimitError` was
 * never true). Building it here keeps the three scan tools testing against one
 * definition of that shape; `intervalsClient.test.ts`'s own error-translation
 * test pins the translation itself.
 */
export function handledRateLimit(
  context: string,
  detail = "15-minute rate limit reached (100/100 requests).",
): RateLimitError {
  return new RateLimitError(
    `intervals.icu rate limit exceeded in ${context}. ${detail}`,
    { status: 429, statusText: "Too Many Requests", data: "" },
    { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
    60,
    detail,
  );
}

/**
 * Builds the `IntervalsApiError` shape `handleApiError` throws for a
 * non-429 HTTP failure: the interpreted message with the status still
 * attached.
 *
 * The class itself lives in `intervalsClient.ts`, which tool tests replace
 * with bare factory mocks, so importing it here would leave the constructor
 * `undefined` under those mocks. `HttpError` from the fetch layer is what the
 * tools' error helper tests `instanceof` against, and it is the base
 * `IntervalsApiError` extends, so the shape is faithful where it matters: the
 * status is on `response`, not buried in the message.
 */
function handledHttpError(
  message: string,
  response: { status: number; statusText: string; data: string },
): HttpError {
  const error = new HttpError(message, response);
  error.name = "IntervalsApiError";
  return error;
}

/**
 * The not-found error an intervals.icu client call actually throws. A plain
 * `Error("404 Not Found")` is a shape only string matching could recognise,
 * and string matching is what the typed rethrow exists to make unnecessary.
 */
export function handledNotFound(context: string): HttpError {
  return handledHttpError(`intervals.icu API Error in ${context} (404)`, {
    status: 404,
    statusText: "Not Found",
    data: '{"message":"Not Found"}',
  });
}

/** The subscription-gated error an intervals.icu client call actually throws. */
export function handledSubscriptionRequired(context: string): HttpError {
  return handledHttpError(
    `intervals.icu API Error in ${context} (402): Payment Required`,
    { status: 402, statusText: "Payment Required", data: "" },
  );
}
