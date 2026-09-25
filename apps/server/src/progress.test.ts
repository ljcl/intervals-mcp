/**
 * Progress reporter behaviour (#279): the no-token path, monotonicity, the
 * time throttle and its `important` bypass, and the promise that a failing
 * transport cannot fail the scan.
 */
import { describe, expect, it } from "vitest";
import {
  createProgressReporter,
  MIN_PROGRESS_INTERVAL_MS,
  NO_PROGRESS,
  type ProgressNotification,
} from "./progress";

/** A `sendNotification` stand-in that records what it was handed. */
function recorder() {
  const sent: ProgressNotification["params"][] = [];
  return {
    sent,
    send: async (n: ProgressNotification) => {
      sent.push(n.params);
    },
  };
}

/** A clock the test advances by hand, so the throttle needs no waiting. */
function clock(start = 0) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("createProgressReporter", () => {
  it("sends nothing when the caller asked for no progress", () => {
    const { sent, send } = recorder();

    const report = createProgressReporter(undefined, send);
    report("scanning", { important: true });

    // Identical to the pre-#279 behaviour, which is the point: a caller that
    // does not opt in pays nothing.
    expect(report).toBe(NO_PROGRESS);
    expect(sent).toHaveLength(0);
  });

  it("echoes the caller's token, whether numeric or a string", () => {
    const a = recorder();
    createProgressReporter(42, a.send)("first");
    const b = recorder();
    createProgressReporter("tok-1", b.send)("first");

    expect(a.sent[0]?.progressToken).toBe(42);
    expect(b.sent[0]?.progressToken).toBe("tok-1");
  });

  it("increases progress strictly, as the spec requires of one token", () => {
    const { sent, send } = recorder();
    const time = clock();
    const report = createProgressReporter("tok", send, time.now);

    report("phase one", { important: true });
    report("phase two", { important: true });
    report("phase three", { important: true });

    expect(sent.map((p) => p.progress)).toEqual([1, 2, 3]);
  });

  it("carries the count in the message, not in a total", () => {
    const { sent, send } = recorder();
    createProgressReporter("tok", send)("Read 37 of 120 activities");

    expect(sent[0]?.message).toBe("Read 37 of 120 activities");
    // A tick counter and a phase denominator cannot share one monotonic
    // number, so `total` is deliberately absent rather than wrong.
    expect(sent[0]).not.toHaveProperty("total");
  });

  it("throttles a burst to one notification per interval", () => {
    const { sent, send } = recorder();
    const time = clock();
    const report = createProgressReporter("tok", send, time.now);

    // A fast pool completing 50 activities inside one second is one line of
    // news, not 50.
    for (let i = 0; i < 50; i++) report(`Read ${i} of 50`);
    expect(sent).toHaveLength(1);

    time.advance(MIN_PROGRESS_INTERVAL_MS);
    report("Read 50 of 50");
    expect(sent).toHaveLength(2);
  });

  it("lets an important update through the throttle", () => {
    const { sent, send } = recorder();
    const time = clock();
    const report = createProgressReporter("tok", send, time.now);

    report("Read 1 of 50");
    time.advance(1);
    report("Read 2 of 50");
    time.advance(1);
    // A rate-limit abort is news whenever it lands.
    report("Rate limit reached, stopping the scan", {
      important: true,
    });

    expect(sent.map((p) => p.message)).toEqual([
      "Read 1 of 50",
      "Rate limit reached, stopping the scan",
    ]);
  });

  it("restarts the throttle window from an important update", () => {
    const { sent, send } = recorder();
    const time = clock();
    const report = createProgressReporter("tok", send, time.now);

    report("phase one", { important: true });
    time.advance(1);
    report("tick");

    expect(sent).toHaveLength(1);
  });

  it("does not fail the call when the transport rejects", async () => {
    const report = createProgressReporter("tok", async () => {
      throw new Error("stream closed");
    });

    // Fire-and-forget: the throw happens on a microtask the handler never
    // awaits, so it must be swallowed rather than becoming an unhandled
    // rejection that takes the scan down.
    expect(() => report("scanning")).not.toThrow();
    await Promise.resolve();
  });

  it("does not make the handler wait on the transport", async () => {
    let resolveSend: (() => void) | undefined;
    const report = createProgressReporter(
      "tok",
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const before = Date.now();
    report("scanning");
    expect(Date.now() - before).toBeLessThan(50);
    expect(resolveSend).toBeDefined();
    resolveSend?.();
  });
});
