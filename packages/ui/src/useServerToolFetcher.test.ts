import { type App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it } from "vitest";
import { renderHook } from "./renderHook";
import { useServerToolFetcher } from "./useServerToolFetcher";

type CallArgs = Parameters<App["callServerTool"]>[0];

function fakeApp(respond: (args: CallArgs) => unknown): {
  app: App;
  calls: CallArgs[];
} {
  const calls: CallArgs[] = [];
  const app = {
    callServerTool: async (args: CallArgs) => {
      calls.push(args);
      return respond(args);
    },
  } as unknown as App;
  return { app, calls };
}

const textResult = (text: string) => ({ content: [{ type: "text", text }] });
const flush = () => new Promise((r) => setTimeout(r, 0));

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
});
