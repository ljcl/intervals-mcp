import { type App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef } from "react";

/**
 * View-exposed tools: letting the model drive a rendered view.
 *
 * Today an app only pushes state *out* (`useModelContextSync`). ext-apps
 * v1.7 added `App.registerTool`, which makes it two-way: when the user asks
 * about the climb at 14 km, the model can pan the map there.
 *
 * ## Why a registry instead of registering from the component
 *
 * Two constraints in the SDK collide, and this module exists to resolve them.
 *
 * 1. **Registration must happen before `connect()`.** `registerTool` calls
 *    `registerCapabilities({tools:…})` only while `!this.transport`, and
 *    `registerCapabilities` throws outright once a transport exists. A tool
 *    registered after the handshake is never advertised in `ui/initialize`,
 *    and installing the `tools/list` handler without the capability throws
 *    "Client does not support tool capability".
 * 2. **The state a tool acts on does not exist until after `connect()`.** The
 *    map's viewBox and the chart's brush window live in the content component,
 *    which `AppRoot` only renders once `app` and `toolArgs` are non-null.
 *
 * So the declaration (name, description, schema) is registered up front against
 * a stable shim, and the component installs the live implementation when it
 * mounts. A call that lands before an implementation is installed reports that
 * the view is still loading (or failed to load) rather than throwing an opaque
 * SDK error.
 *
 * ## Why there is no host-capability gate
 *
 * The issue that asked for this assumed one. There isn't one to use:
 * `McpUiHostCapabilities` has `serverTools` (the host will proxy calls *to the
 * MCP server*), `updateModelContext`, `message`, `sampling` — and nothing that
 * says the host will call tools the *app* exposes. Nor could a gate work if it
 * existed, since host capabilities are only known after `connect()` and
 * registration has to precede it.
 *
 * A gate is unnecessary anyway. Registering before connect sends nothing: the
 * `sendToolListChanged` inside `registerTool` is suppressed while the
 * handshake has not completed, so all that reaches an unsupporting host is one
 * extra key in the `ui/initialize` capabilities it already ignores. It then
 * never sends `tools/list` or `tools/call`, and the app behaves exactly as
 * before. The no-op is structural rather than conditional.
 */

/** What a view tool hands back to the host. */
export interface ViewToolResult {
  /** One line describing what the view now shows, for the model to read. */
  text: string;
  isError?: boolean;
}

/**
 * A tool a view exposes. The schema is declared with zod and kept as `unknown`
 * here: `registerTool` reads it as a Standard Schema, which zod 4 implements
 * (validation and the advertised JSON Schema), and this module has no use for
 * its type.
 */
export interface ViewToolDefinition {
  name: string;
  /** Model-facing prose: when to call this, and what it does to the view. */
  description: string;
  title?: string;
  /**
   * A zod object (`.strict()`, every field `.nullish()`). Every field is
   * optional because a view tool is a nudge from the model ("show me 12-18
   * km", "reset the zoom"), and the handler decides which combinations are
   * meaningful. `.strict()` rejects an unknown key instead of letting a
   * model's mistake look like success.
   */
  inputSchema: unknown;
}

/**
 * The live half, installed by the component that owns the state. Receives the
 * validated arguments with null-valued keys already removed.
 */
export type ViewToolHandler = (
  args: Record<string, unknown>,
) => ViewToolResult | Promise<ViewToolResult>;

/**
 * Shown when the host calls a tool before the view has mounted its handler.
 * Deliberately not an SDK error: "not ready yet" is a real, recoverable state
 * and the model should be told to retry, not handed a stack trace. A card
 * whose data failed to load shows its ErrorState and never mounts the handler
 * either, so the text covers that too.
 */
const NOT_READY =
  "The view is still loading, or it failed to load, so it cannot be adjusted yet.";

/** A view tool is a nudge: null from a model means "not given" (#68). */
function withoutNulls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
}

/**
 * Holds the declared tools and the handlers installed against them. One per
 * app instance, created before `connect()`.
 */
export class ViewToolRegistry {
  private readonly handlers = new Map<string, ViewToolHandler>();
  private registered = false;

  /**
   * Declare every tool on the app. Must be called inside `onAppCreated`,
   * before `connect()` — see the module comment. Idempotent, because React
   * strict mode can create and discard an app before the real one.
   */
  register(app: App, definitions: readonly ViewToolDefinition[]): void {
    if (this.registered || definitions.length === 0) return;
    this.registered = true;

    // `registerTool` is generic over Standard Schema, and inferring through
    // an `unknown` schema collapses the callback's arg type to `never`. The
    // schema type lives in `@standard-schema/spec`, which this package does
    // not depend on (each app owns its own zod), so the boundary is crossed
    // once here with the shape written out rather than with `as never`
    // sprinkled through the call.
    const registerTool = app.registerTool.bind(app) as unknown as (
      name: string,
      config: {
        title?: string;
        description: string;
        inputSchema: unknown;
        annotations: Record<string, boolean>;
      },
      cb: (args: unknown) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
      }>,
    ) => void;

    for (const definition of definitions) {
      registerTool(
        definition.name,
        {
          ...(definition.title ? { title: definition.title } : {}),
          description: definition.description,
          inputSchema: definition.inputSchema,
          // A view tool only moves the view it belongs to: nothing is written
          // anywhere, and calling it twice leaves the same view. Stated in
          // full because `destructiveHint` defaults to true, so a host that
          // reads it first would file a pure view control under write/delete
          // (the same trap the server's READ_ONLY annotation avoids).
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args: unknown) => {
          const result = await this.invoke(
            definition.name,
            (args ?? {}) as Record<string, unknown>,
          );
          return {
            content: [{ type: "text" as const, text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          };
        },
      );
    }
  }

  /** Install (or replace) the implementation for one declared tool. */
  setHandler(name: string, handler: ViewToolHandler): void {
    this.handlers.set(name, handler);
  }

  /** Remove an implementation when its component unmounts. */
  clearHandler(name: string): void {
    this.handlers.delete(name);
  }

  /** Test seam: call a tool the way the host would. */
  async invoke(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ViewToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) return { text: NOT_READY, isError: true };
    return await handler(withoutNulls(args));
  }
}

/**
 * Install a view tool's implementation for as long as the component is
 * mounted.
 */
export function useViewTool(
  registry: ViewToolRegistry | null,
  name: string,
  handler: ViewToolHandler,
): void {
  // The handler closes over state that changes every render. The installed
  // shim reads the latest one through a ref, so the effect runs once per
  // mount instead of re-installing on every state change.
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!registry) return;
    registry.setHandler(name, (args) => latest.current(args));
    return () => registry.clearHandler(name);
  }, [registry, name]);
}
