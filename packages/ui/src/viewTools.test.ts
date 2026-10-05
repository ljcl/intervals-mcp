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
import { optionalObjectSchema } from "./standardSchema";
import { type ViewToolDefinition, ViewToolRegistry } from "./viewTools";

const DEFINITION: ViewToolDefinition = {
  name: "set-viewport",
  description: "Frame a stretch of the course.",
  inputSchema: optionalObjectSchema({
    fromKm: { type: "number", description: "Start, km.", minimum: 0 },
  }),
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
    expect(result.content[0]?.text).toMatch(/still loading/i);
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
});

describe("optionalObjectSchema", () => {
  const schema = optionalObjectSchema({
    fromKm: { type: "number", description: "Start, km.", minimum: 0 },
    reset: { type: "boolean", description: "Show the whole route." },
  });
  const std = schema["~standard"];

  it("advertises a JSON Schema the SDK can serialize", () => {
    // Without `jsonSchema` the SDK throws rather than falling back.
    expect(std.jsonSchema.input()).toEqual({
      type: "object",
      properties: {
        fromKm: { type: "number", description: "Start, km.", minimum: 0 },
        reset: { type: "boolean", description: "Show the whole route." },
      },
      additionalProperties: false,
    });
  });

  it("requires nothing, so a partial nudge from the model is valid", () => {
    expect(std.validate({})).toEqual({ value: {} });
    expect(std.validate(undefined)).toEqual({ value: {} });
    expect(std.validate({ reset: true })).toEqual({ value: { reset: true } });
  });

  it("accepts a number the host stringified", () => {
    expect(std.validate({ fromKm: "12.5" })).toEqual({
      value: { fromKm: 12.5 },
    });
  });

  it("rejects a value that is not a number at all", () => {
    expect(std.validate({ fromKm: "soon" })).toMatchObject({
      issues: [{ message: "expected a number", path: ["fromKm"] }],
    });
  });

  it("enforces a minimum", () => {
    expect(std.validate({ fromKm: -4 })).toMatchObject({
      issues: [{ message: "must be at least 0", path: ["fromKm"] }],
    });
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    // Silently dropping it would make a model's mistake look like success.
    expect(std.validate({ toKm: 5 })).toMatchObject({
      issues: [{ message: "unknown argument", path: ["toKm"] }],
    });
  });

  it("rejects a non-object", () => {
    expect(std.validate([1, 2])).toMatchObject({ issues: expect.any(Array) });
    expect(std.validate("nope")).toMatchObject({ issues: expect.any(Array) });
  });

  it("treats an explicit null field as absent", () => {
    expect(std.validate({ fromKm: null })).toEqual({ value: {} });
  });
});
