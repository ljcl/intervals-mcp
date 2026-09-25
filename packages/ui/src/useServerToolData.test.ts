import { type App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it } from "vitest";
import { renderHook } from "./renderHook";
import { useServerToolData } from "./useServerToolData";

type CallArgs = Parameters<App["callServerTool"]>[0];
type CallOptions = NonNullable<Parameters<App["callServerTool"]>[1]>;

/** Hand-rolled fake App exposing only what the hook calls. */
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

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

/** Let queued microtasks and the hook's state updates settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useServerToolData", () => {
  it("starts loading and resolves with the parsed payload", async () => {
    const { app, calls } = fakeApp(() =>
      textResult(JSON.stringify({ weeks: 6 })),
    );

    const harness = await renderHook(
      ({ args }) => useServerToolData<{ weeks: number }>(app, "get-data", args),
      { args: { days: 84 } },
    );

    expect(calls).toEqual([{ name: "get-data", arguments: { days: 84 } }]);
    await flush();
    expect(harness.current().data).toEqual({ weeks: 6 });
    expect(harness.current().loading).toBe(false);
    expect(harness.current().error).toBeNull();

    await harness.unmount();
  });

  it("reports a parse failure rather than a null payload", async () => {
    const { app } = fakeApp(() => textResult("not json"));

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().error).toBe("Failed to parse get-data response");
    expect(harness.current().data).toBeNull();
    expect(harness.current().loading).toBe(false);

    await harness.unmount();
  });

  it("reports a response carrying no text content", async () => {
    const { app } = fakeApp(() => ({ content: [] }));

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().error).toBe("Failed to parse get-data response");

    await harness.unmount();
  });

  it("surfaces an isError result's prose instead of a parse failure", async () => {
    // What a caller gets back when a server tool answers with a structured
    // error instead of the expected data payload.
    const { app } = fakeApp(() => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "Tool error: Activity zone history requires a paid subscription.",
        },
      ],
    }));

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().error).toBe(
      "Tool error: Activity zone history requires a paid subscription.",
    );
    expect(harness.current().data).toBeNull();
    expect(harness.current().loading).toBe(false);

    await harness.unmount();
  });

  it("names the tool when an isError result carries no text", async () => {
    const { app } = fakeApp(() => ({ isError: true, content: [] }));

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().error).toBe("get-data failed");

    await harness.unmount();
  });

  it("surfaces a thrown call as the error", async () => {
    const { app } = fakeApp(() => {
      throw new Error("host disconnected");
    });

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().error).toBe("Error: host disconnected");
    expect(harness.current().loading).toBe(false);

    await harness.unmount();
  });

  it("re-invokes callServerTool on retry", async () => {
    let attempt = 0;
    const { app, calls } = fakeApp(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("flaky");
      return textResult(JSON.stringify({ ok: true }));
    });

    const harness = await renderHook(
      () => useServerToolData<{ ok: boolean }>(app, "get-data", {}),
      undefined,
    );
    await flush();
    expect(harness.current().error).toBe("Error: flaky");

    harness.current().retry();
    await flush();

    expect(calls).toHaveLength(2);
    expect(harness.current().data).toEqual({ ok: true });
    expect(harness.current().error).toBeNull();

    await harness.unmount();
  });

  it("does not refetch for a new-but-equal args object", async () => {
    const { app, calls } = fakeApp(() => textResult(JSON.stringify({})));

    const harness = await renderHook(
      ({ days }) => useServerToolData(app, "get-data", { days }),
      { days: 84 },
    );
    await flush();
    expect(calls).toHaveLength(1);

    // A fresh object literal with the same contents — the args key is the
    // JSON serialization, so this must not re-enter the fetch.
    await harness.rerender({ days: 84 });
    await flush();
    expect(calls).toHaveLength(1);

    await harness.unmount();
  });

  it("refetches when the args actually change", async () => {
    const { app, calls } = fakeApp(() => textResult(JSON.stringify({})));

    const harness = await renderHook(
      ({ days }) => useServerToolData(app, "get-data", { days }),
      { days: 84 },
    );
    await flush();

    await harness.rerender({ days: 42 });
    await flush();

    expect(calls).toEqual([
      { name: "get-data", arguments: { days: 84 } },
      { name: "get-data", arguments: { days: 42 } },
    ]);

    await harness.unmount();
  });

  it("stays loading with no app, and fetches once one connects", async () => {
    const { app, calls } = fakeApp(() => textResult(JSON.stringify({})));

    const harness = await renderHook(
      ({ connected }) => useServerToolData(connected, "get-data", {}),
      { connected: null } as { connected: App | null },
    );
    await flush();

    expect(calls).toHaveLength(0);
    expect(harness.current().loading).toBe(true);

    await harness.rerender({ connected: app });
    await flush();

    expect(calls).toHaveLength(1);
    expect(harness.current().loading).toBe(false);

    await harness.unmount();
  });
  it("asks for the progress-based timeout reset (#279)", async () => {
    const { app, options } = fakeApp(() => textResult(JSON.stringify({})));

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    // Without this a long history sweep is killed by the host's default
    // request timeout while it is still making progress.
    expect(options[0]?.resetTimeoutOnProgress).toBe(true);

    await harness.unmount();
  });

  it("surfaces the latest progress message while loading", async () => {
    const { app } = fakeApp(async (_args, options) => {
      options?.onprogress?.({ progress: 1, message: "Listed 200 activities" });
      options?.onprogress?.({ progress: 2, message: "Listed 400 activities" });
      return textResult(JSON.stringify({ ok: true }));
    });

    const harness = await renderHook(
      () => useServerToolData<{ ok: boolean }>(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().progress).toBe("Listed 400 activities");

    await harness.unmount();
  });

  it("ignores a progress notification carrying no message", async () => {
    const { app } = fakeApp(async (_args, options) => {
      options?.onprogress?.({ progress: 1, message: "Listing activities" });
      // A bare tick is a timeout reset, not a new thing to say — it must not
      // blank the line the user is reading.
      options?.onprogress?.({ progress: 2 });
      return textResult(JSON.stringify({}));
    });

    const harness = await renderHook(
      () => useServerToolData(app, "get-data", {}),
      undefined,
    );
    await flush();

    expect(harness.current().progress).toBe("Listing activities");

    await harness.unmount();
  });

  it("clears the stale progress line when a failed fetch is retried", async () => {
    let attempt = 0;
    const { app } = fakeApp(async (_args, options) => {
      attempt += 1;
      if (attempt === 1) {
        options?.onprogress?.({
          progress: 1,
          message: "Listed 200 activities",
        });
        throw new Error("flaky");
      }
      return textResult(JSON.stringify({ ok: true }));
    });

    const harness = await renderHook(
      () => useServerToolData<{ ok: boolean }>(app, "get-data", {}),
      undefined,
    );
    await flush();
    expect(harness.current().progress).toBe("Listed 200 activities");

    harness.current().retry();
    await flush();

    // The second attempt reported nothing, so showing the first attempt's
    // last line would describe work that is not happening.
    expect(harness.current().progress).toBeNull();
    expect(harness.current().data).toEqual({ ok: true });

    await harness.unmount();
  });
});
