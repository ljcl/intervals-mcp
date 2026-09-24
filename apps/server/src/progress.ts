/**
 * Tool-call progress notifications.
 *
 * Several tools fan out over more than one request: the training-load /
 * fitness-trend feeds page through an athlete's history, and `get-best-efforts`
 * (now backed by intervals.icu pace curves) makes one or two calls per
 * `topN`. Until now every one of them was silent from the first
 * request to the last, so an
 * MCP App showed a bare skeleton for a minute and a host's request timeout had
 * nothing to reset itself against (ext-apps v1.6.0 resets on progress).
 *
 * ## Why the count lives in the message, not in `total`
 *
 * The spec requires `progress` to strictly increase for the lifetime of one
 * progress token. A single call has several phases with different
 * denominators — "page 3 of an unknown number", then "activity 87 of 120" —
 * and one monotonic number cannot honestly carry two of them: continuing the
 * counter across phases overshoots `total`, and restarting it goes backwards.
 * So `progress` is a plain tick counter, `total` is omitted, and the countable
 * detail is written into `message`, which is what an app renders anyway. A
 * client loses a determinate progress bar and gains a line that is true.
 *
 * ## Why the throttle is time-based
 *
 * Progress exists to keep a client's timeout alive and to show liveness, and
 * both are time-shaped concerns — a scan that completes 60 activities in a
 * second needs one notification, not 60. Counting-based throttling (every Nth
 * item) gets this wrong in both directions depending on how fast Strava
 * answers. `important` updates bypass the throttle, because a phase change or
 * a rate-limit abort is news regardless of when the last tick went out.
 *
 * Like telemetry, this must never be able to fail or slow the call it
 * describes: every send is fire-and-forget and every failure is swallowed.
 */

/** Minimum gap between throttled notifications. */
export const MIN_PROGRESS_INTERVAL_MS = 1000;

export interface ProgressOptions {
  /**
   * Bypass the throttle. For phase changes and terminal notes ("rate limit
   * reached"), which are news whenever they happen.
   */
  important?: boolean;
}

/**
 * Report progress for the call in flight. Handlers take one of these as their
 * third argument and may call it freely — throttling and delivery are this
 * module's problem, not theirs.
 */
export type ReportProgress = (
  message: string,
  options?: ProgressOptions,
) => void;

/**
 * The reporter a call gets when the caller sent no `progressToken`. A tool
 * therefore never branches on whether progress was requested.
 */
export const NO_PROGRESS: ReportProgress = () => {};

/** The notification shape the MCP SDK's `sendNotification` accepts. */
export interface ProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    message?: string;
  };
}

/**
 * Build a reporter bound to one request's progress token. Returns
 * {@link NO_PROGRESS} when the caller did not ask for progress, so the
 * no-token path costs nothing and behaves identically to before.
 *
 * @param progressToken - `_meta.progressToken` from the CallTool request.
 * @param send - `extra.sendNotification`, already scoped to the request.
 * @param now - Clock seam, so the throttle is testable without waiting.
 */
export function createProgressReporter(
  progressToken: string | number | undefined,
  send: (notification: ProgressNotification) => Promise<void>,
  now: () => number = Date.now,
): ReportProgress {
  if (progressToken === undefined) return NO_PROGRESS;

  let ticks = 0;
  let lastSentAt = Number.NEGATIVE_INFINITY;

  return (message, options) => {
    const at = now();
    if (!options?.important && at - lastSentAt < MIN_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastSentAt = at;
    ticks += 1;

    // Fire-and-forget: a handler must not wait on the transport, and a
    // notification that cannot be delivered is not worth failing a scan over.
    void send({
      method: "notifications/progress",
      params: { progressToken, progress: ticks, message },
    }).catch(() => {});
  };
}

/**
 * Adapter for `getAllActivities`'s per-page callback. Five tools paginate the
 * athlete's history; routing them through one adapter keeps the wording
 * identical across all of them rather than five near-miss variants.
 */
export function listingProgress(
  progress: ReportProgress,
): (fetched: number) => void {
  return (fetched) => progress(`Listed ${fetched} activities`);
}
