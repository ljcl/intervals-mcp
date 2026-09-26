import { type App } from "@modelcontextprotocol/ext-apps";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "./renderHook";
import { useServerToolFetcher } from "./useServerToolFetcher";

type CallArgs = Parameters<App["callServerTool"]>[0];
type CallOptions = NonNullable<Parameters<App["callServerTool"]>[1]>;

function fakeApp(
  respond: (
    args: CallArgs,
    options?: CallOptions,
  ) => unknown | Promise<unknown>,
): {
  app: App;
  calls: CallArgs[];
  options: Array<CallOptions | undefined>;
} {
  const calls: CallArgs[] = [];
  const options: Array<CallOptions | undefined> = [];
  const app = {
    callServerTool: async (args: CallArgs, opts?: CallOptions) => {
      calls.push(args);
      options.push(opts);
      return await respond(args, opts);
    },
  } as unknown as App;
  return { app, calls, options };
}

/** A call that never settles, so its key stays in flight. */
const inFlight = () => new Promise<never>(() => {});

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

/**
 * Let queued microtasks settle inside `act`, so React commits the hook's
 * state updates before the test reads them. A bare timer tick races React's
 * scheduler on a slow runner.
 */
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe("useServerToolFetcher", () => {
  it("builds each key's arguments and exposes the parsed payload", async () => {
    const { app, calls } = fakeApp((args) =>
      textResult(
        JSON.stringify({
          id: (args.arguments as { activity_id: string }).activity_id,
        }),
      ),
    );

    const harness = await renderHook(
      () =>
        useServerToolFetcher<{ id: string }>(app, "get-streams", (key) => ({
          activity_id: key,
        })),
      undefined,
    );

    harness.current().request("10003");
    await flush();

    expect(calls).toEqual([
      { name: "get-streams", arguments: { activity_id: "10003" } },
    ]);
    expect(harness.current().entries.get("10003")).toEqual({
      data: { id: "10003" },
      loading: false,
      error: null,
      progress: null,
    });

    await harness.unmount();
  });

  it("drops requests made before the host handshake completes", async () => {
    const harness = await renderHook(
      ({ connected }: { connected: App | null }) =>
        useServerToolFetcher(connected, "get-streams", (key) => ({ key })),
      { connected: null },
    );

    harness.current().request("10003");
    await flush();

    // Dropped rather than recorded as a failure, so the caller's effect can
    // re-request once the app lands without needing a retry.
    expect(harness.current().entries.size).toBe(0);

    await harness.unmount();
  });

  it("surfaces a parse failure as that key's error, and retries past it", async () => {
    let attempt = 0;
    const { app, calls } = fakeApp(() => {
      attempt += 1;
      return attempt === 1
        ? textResult("not json")
        : textResult(JSON.stringify({ ok: true }));
    });

    const harness = await renderHook(
      () =>
        useServerToolFetcher<{ ok: boolean }>(app, "get-streams", (key) => ({
          activity_id: key,
        })),
      undefined,
    );

    harness.current().request("10003");
    await flush();
    expect(harness.current().entries.get("10003")?.error).toBe(
      "Error: Failed to parse get-streams response",
    );

    // A repeat request must not re-fire; only the retry control does.
    harness.current().request("10003");
    await flush();
    expect(calls).toHaveLength(1);

    harness.current().retry("10003");
    await flush();
    expect(calls).toHaveLength(2);
    expect(harness.current().entries.get("10003")?.data).toEqual({ ok: true });

    await harness.unmount();
  });

  it("throws an isError result's prose rather than a parse failure", async () => {
    const { app } = fakeApp(() => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "INTERVALS_API_KEY is not set. Add your intervals.icu API key.",
        },
      ],
    }));

    const harness = await renderHook(
      () =>
        useServerToolFetcher(app, "get-streams", (key) => ({
          activity_id: key,
        })),
      undefined,
    );

    harness.current().request("10003");
    await flush();

    expect(harness.current().entries.get("10003")?.error).toBe(
      "Error: INTERVALS_API_KEY is not set. Add your intervals.icu API key.",
    );

    await harness.unmount();
  });

  it("keeps the store across renders that change the args builder", async () => {
    const { app, calls } = fakeApp(() => textResult(JSON.stringify({})));

    const harness = await renderHook(
      ({ suffix }: { suffix: string }) =>
        // A fresh arrow every render: it is read through a ref, so it must
        // not tear down the store and lose what has already been fetched.
        useServerToolFetcher(app, "get-streams", (key) => ({
          activity_id: `${key}${suffix}`,
        })),
      { suffix: "" },
    );

    harness.current().request("10003");
    await flush();
    expect(calls).toHaveLength(1);

    await harness.rerender({ suffix: "" });
    harness.current().request("10003");
    await flush();

    expect(calls).toHaveLength(1);
    expect(harness.current().entries.has("10003")).toBe(true);

    await harness.unmount();
  });

  it("asks for the progress-based timeout reset on every keyed call (#55)", async () => {
    const { app, options } = fakeApp(() => textResult(JSON.stringify({})));

    const harness = await renderHook(
      () =>
        useServerToolFetcher(app, "get-streams", (key) => ({
          activity_id: key,
        })),
      undefined,
    );

    harness.current().request("10003");
    harness.current().request("10013");
    await flush();

    // Without these a slow call is killed by the host's default request
    // timeout while it is still making progress, and its message is lost.
    expect(options).toHaveLength(2);
    for (const opts of options) {
      expect(opts?.resetTimeoutOnProgress).toBe(true);
      expect(opts?.onprogress).toBeTypeOf("function");
    }

    await harness.unmount();
  });

  it("records a progress message on its own key only", async () => {
    const { app, calls, options } = fakeApp(inFlight);

    const harness = await renderHook(
      () =>
        useServerToolFetcher(app, "get-streams", (key) => ({
          activity_id: key,
        })),
      undefined,
    );

    harness.current().request("10003");
    harness.current().request("10013");
    await flush();

    // Calls land in request order, so the first call's options are 10003's.
    expect(calls[0]?.arguments).toEqual({ activity_id: "10003" });
    options[0]?.onprogress?.({ progress: 1, message: "Listed 200 activities" });
    await flush();

    expect(harness.current().entries.get("10003")).toEqual({
      data: null,
      loading: true,
      error: null,
      progress: "Listed 200 activities",
    });
    expect(harness.current().entries.get("10013")?.progress).toBeNull();

    await harness.unmount();
  });

  it("ignores a progress notification carrying no message", async () => {
    const { app, options } = fakeApp(inFlight);

    const harness = await renderHook(
      () =>
        useServerToolFetcher(app, "get-streams", (key) => ({
          activity_id: key,
        })),
      undefined,
    );

    harness.current().request("10003");
    await flush();

    options[0]?.onprogress?.({ progress: 1, message: "Listing activities" });
    // A bare tick is a timeout reset, not a new thing to say. It must not
    // blank the line the user is reading.
    options[0]?.onprogress?.({ progress: 2 });
    await flush();

    expect(harness.current().entries.get("10003")?.progress).toBe(
      "Listing activities",
    );

    await harness.unmount();
  });
});
