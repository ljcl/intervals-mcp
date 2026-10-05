/**
 * Test helpers for view-tool declarations, exported as `@intervals-mcp/ui/testing`.
 *
 * Kept off the package index on purpose: it imports `vitest`, so it must only
 * ever be reached from a test file, never from an app bundle.
 *
 * Why a shared contract instead of each app testing its own schema: a view
 * tool's declaration is read by the real SDK, not by this repo, and every way
 * it can be wrong is silent until a host calls it. A field missing `.nullish()`
 * makes the SDK throw on a model's `null`; a missing `.strict()` lets a typo
 * pass as a no-op. `expectViewToolContract` drives the declarations through a
 * real `App` (`onlisttools` / `oncalltool`, the calls a host makes), so what it
 * checks is what a host sees.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { expect } from "vitest";
import { type ViewToolDefinition, ViewToolRegistry } from "./viewTools";

type JsonObject = Record<string, unknown>;

/** A tool as `tools/list` hands it to a host. */
export interface AdvertisedViewTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject & {
    type?: unknown;
    properties?: Record<string, JsonObject>;
    required?: unknown;
    additionalProperties?: unknown;
  };
  annotations?: Record<string, unknown>;
}

/** What the SDK passes as the second argument; the tools never read it. */
const NO_EXTRA = {} as never;

/** An app with the definitions registered, plus the registry to drive them. */
function connect(definitions: readonly ViewToolDefinition[]) {
  const app = new App({ name: "view-tool-contract", version: "0.0.0" });
  const registry = new ViewToolRegistry();
  registry.register(app, definitions);
  return { app, registry };
}

type ContractApp = ReturnType<typeof connect>["app"];

async function listTools(app: ContractApp): Promise<AdvertisedViewTool[]> {
  const result = await app.onlisttools?.({}, NO_EXTRA);
  return (result?.tools ?? []) as unknown as AdvertisedViewTool[];
}

async function callTool(
  app: ContractApp,
  name: string,
  args: Record<string, unknown> | undefined,
) {
  const call = app.oncalltool;
  if (!call) throw new Error("the app installed no tool-call handler");
  return await call({ name, arguments: args }, NO_EXTRA);
}

/**
 * The tools exactly as a host receives them from `tools/list`, for a test
 * that pins a declaration's fields.
 */
export async function advertisedViewTools(
  definitions: readonly ViewToolDefinition[],
): Promise<AdvertisedViewTool[]> {
  return await listTools(connect(definitions).app);
}

function isNullBranch(branch: unknown): boolean {
  return (
    typeof branch === "object" &&
    branch !== null &&
    (branch as JsonObject).type === "null"
  );
}

/** One property's schema with the `null` alternative that `.nullish()` adds removed. */
function withoutNullAlternative(property: JsonObject): JsonObject {
  const { anyOf, type, ...rest } = property;
  if (Array.isArray(anyOf)) {
    const branches = anyOf.filter((branch) => !isNullBranch(branch));
    return branches.length === 1
      ? { ...rest, ...(branches[0] as JsonObject) }
      : { ...rest, anyOf: branches };
  }
  if (Array.isArray(type)) {
    const types = type.filter((t) => t !== "null");
    return { ...rest, type: types.length === 1 ? types[0] : types };
  }
  return property;
}

/**
 * A tool's advertised properties as the model reads them: every field's schema
 * with the nullable wrapper taken off, so a test pins `{ type: "number",
 * minimum: 0, description }` rather than zod's `anyOf` plumbing. That a field
 * accepts null is the contract's job, not each pin's.
 */
export function viewToolFields(
  tool: AdvertisedViewTool,
): Record<string, JsonObject> {
  return Object.fromEntries(
    Object.entries(tool.inputSchema.properties ?? {}).map(([key, property]) => [
      key,
      withoutNullAlternative(property),
    ]),
  );
}

/**
 * Assert the contract every view tool must keep, for each definition:
 *
 * - advertised as an object with `additionalProperties: false` and nothing
 *   `required` (a view tool is a nudge from the model, not a form);
 * - annotated `readOnlyHint: true` with `destructiveHint: false` stated;
 * - every property accepts `null`, which reaches the handler as "not given";
 * - an empty or omitted argument object is valid;
 * - an unknown key is rejected rather than ignored.
 *
 * Pair it with a test that pins the tool's own field names, bounds and prose.
 */
export async function expectViewToolContract(
  definitions: readonly ViewToolDefinition[],
): Promise<void> {
  expect(definitions.length, "at least one view tool").toBeGreaterThan(0);
  const { app, registry } = connect(definitions);

  const tools = await listTools(app);
  expect(tools.map((tool) => tool.name)).toEqual(
    definitions.map((definition) => definition.name),
  );

  for (const tool of tools) {
    const { inputSchema } = tool;
    expect(inputSchema.type, `${tool.name} input type`).toBe("object");
    expect(
      inputSchema.additionalProperties,
      `${tool.name} additionalProperties`,
    ).toBe(false);
    expect(inputSchema, `${tool.name} required`).not.toHaveProperty("required");
    expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const keys = Object.keys(inputSchema.properties ?? {});
    expect(keys.length, `${tool.name} has properties`).toBeGreaterThan(0);

    const seen: Array<Record<string, unknown>> = [];
    registry.setHandler(tool.name, (args) => {
      seen.push(args);
      return { text: "ok" };
    });

    for (const key of keys) {
      const result = await callTool(app, tool.name, { [key]: null }).catch(
        (error: unknown) => {
          throw new Error(
            `${tool.name}: ${key} should accept null (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        },
      );
      expect(result.isError, `${tool.name}.${key} null`).toBeUndefined();
    }
    await callTool(app, tool.name, {});
    await callTool(app, tool.name, undefined);
    // Null and absent both reach the handler as "not given".
    expect(seen, `${tool.name} nulls`).toEqual(
      Array.from({ length: keys.length + 2 }, () => ({})),
    );

    await expect(
      callTool(app, tool.name, { notAnArgument: 1 }),
    ).rejects.toThrow(/Invalid input for tool/);

    registry.clearHandler(tool.name);
  }
}
