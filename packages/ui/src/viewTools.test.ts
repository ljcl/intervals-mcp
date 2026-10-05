/**
 * View-tool registration and the schema behind it (ljcl/strava-mcp#278).
 *
 * The registry exists to resolve an ordering constraint in the SDK — tools
 * must be declared before `connect()`, but the state they act on only exists
 * after it — so the tests are mostly about that seam: a call before the view
 * mounts, a handler installed later, and one removed on unmount.
 */
import { type App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ViewToolDefinition, ViewToolRegistry } from "./viewTools";

/**
 * The shape every view tool declares: strict, every field nullish. The shipped
 * declarations are held to that by `expectViewToolContract` (see testing.ts).
 */
const SCHEMA = z
  .object({
    fromKm: z.number().min(0).nullish().describe("Start, km."),
    reset: z.boolean().nullish().describe("Show the whole route."),
  })
  .strict();

const DEFINITION: ViewToolDefinition = {
  name: "set-viewport",
  description: "Frame a stretch of the course.",
  inputSchema: SCHEMA,
};

/** An App stand-in capturing what registerTool was handed. */
function fakeApp() {
  const registered: Array<{
    name: string;
    config: Record<string, unknown>;
    cb: (args: unknown) => Promise<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>;
  }> = [];
  const app = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      cb: (args: unknown) => Promise<never>,
    ) => {
      registered.push({ name, config, cb });
    },
  } as unknown as App;
  return { app, registered };
}

describe("ViewToolRegistry", () => {
  it("declares each tool on the app", () => {
    const { app, registered } = fakeApp();

    new ViewToolRegistry().register(app, [DEFINITION]);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("set-viewport");
    expect(registered[0]?.config.description).toBe(
      "Frame a stretch of the course.",
    );
  });

  it("marks a view tool read-only, and says so explicitly", () => {
    const { app, registered } = fakeApp();
    new ViewToolRegistry().register(app, [DEFINITION]);

    // `destructiveHint` defaults to true, so a host reading it first would
    // file a pure view control under write/delete and re-prompt forever.
    expect(registered[0]?.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("registers once even if called again", () => {
    const { app, registered } = fakeApp();
    const registry = new ViewToolRegistry();

    // React strict mode creates and discards an app before the real one.
    registry.register(app, [DEFINITION]);
    registry.register(app, [DEFINITION]);

    expect(registered).toHaveLength(1);
  });

  it("touches the app at all only when there are tools to declare", () => {
    const { app, registered } = fakeApp();
    new ViewToolRegistry().register(app, []);
    expect(registered).toHaveLength(0);
  });

  it("reports 'still loading' when called before the view mounts", async () => {
    const { app, registered } = fakeApp();
    new ViewToolRegistry().register(app, [DEFINITION]);

    const result = await registered[0]!.cb({ fromKm: 3 });

    // Not an SDK throw: "not ready yet" is recoverable and the model should
    // be told to retry, not handed a stack trace.
    expect(result.isError).toBe(true);
    // A card whose data failed shows its ErrorState and never installs a
    // handler either, so the text must be true for that card too.
    expect(result.content[0]?.text).toBe(
      "The view is still loading, or it failed to load, so it cannot be adjusted yet.",
    );
  });

  it("routes a call to the handler the view installed", async () => {
    const { app, registered } = fakeApp();
    const registry = new ViewToolRegistry();
    registry.register(app, [DEFINITION]);

    registry.setHandler("set-viewport", (args) => ({
      text: `framed from ${String(args.fromKm)} km`,
    }));
    const result = await registered[0]!.cb({ fromKm: 12 });

    expect(result.content[0]?.text).toBe("framed from 12 km");
    expect(result.isError).toBeUndefined();
  });

  it("goes back to 'still loading' once the view unmounts", async () => {
    const registry = new ViewToolRegistry();
    registry.setHandler("set-viewport", () => ({ text: "framed" }));
    registry.clearHandler("set-viewport");

    await expect(registry.invoke("set-viewport")).resolves.toMatchObject({
      isError: true,
    });
  });

  it("passes a handler's own error through as a tool error", async () => {
    const { app, registered } = fakeApp();
    const registry = new ViewToolRegistry();
    registry.register(app, [DEFINITION]);
    registry.setHandler("set-viewport", () => ({
      text: "This route has no recorded distances.",
      isError: true,
    }));

    const result = await registered[0]!.cb({});

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "This route has no recorded distances." }],
    });
  });

  it("hands a handler null-valued arguments as absent", async () => {
    // Models send null for a field they are leaving out (#68); the handler
    // only ever has to ask "was it given".
    const registry = new ViewToolRegistry();
    const seen: unknown[] = [];
    registry.setHandler("set-viewport", (args) => {
      seen.push(args);
      return { text: "ok" };
    });

    await registry.invoke("set-viewport", { fromKm: null, toKm: 2 });

    expect(seen).toEqual([{ toKm: 2 }]);
    expect(Object.keys(seen[0] as object)).toEqual(["toKm"]);
  });

  it("strips nulls on the path the host's call takes too", async () => {
    const { app, registered } = fakeApp();
    const registry = new ViewToolRegistry();
    registry.register(app, [DEFINITION]);
    const seen: unknown[] = [];
    registry.setHandler("set-viewport", (args) => {
      seen.push(args);
      return { text: "ok" };
    });

    await registered[0]!.cb({ fromKm: null, reset: true });

    expect(seen).toEqual([{ reset: true }]);
    expect(Object.keys(seen[0] as object)).toEqual(["reset"]);
  });

  it("keeps a falsy value that is not null", async () => {
    const registry = new ViewToolRegistry();
    const seen: unknown[] = [];
    registry.setHandler("set-viewport", (args) => {
      seen.push(args);
      return { text: "ok" };
    });

    await registry.invoke("set-viewport", { fromKm: 0, reset: false });

    expect(seen).toEqual([{ fromKm: 0, reset: false }]);
  });
});
