import {
  type App,
  type McpUiAppCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useRef, useState } from "react";
import { useLatestPin } from "./latestPin";
import { type HostCtx, useMobileMode } from "./useMobileMode";
import { type ViewToolDefinition, ViewToolRegistry } from "./viewTools";

/** Layout mode every MCP App view switches on. */
export type AppMode = "mobile" | "desktop";

const DEFAULT_CAPABILITIES: McpUiAppCapabilities = {
  availableDisplayModes: ["inline", "fullscreen"],
};

/** Narrow the raw ext-apps host context down to the fields we react to. */
function pickHostCtx(ctx: McpUiHostContext): HostCtx {
  return {
    platform: ctx.platform,
    containerDimensions: ctx.containerDimensions,
    safeAreaInsets: ctx.safeAreaInsets,
    deviceCapabilities: ctx.deviceCapabilities,
    userAgent: ctx.userAgent,
    displayMode: ctx.displayMode,
    availableDisplayModes: ctx.availableDisplayModes,
  };
}

/**
 * Fallback for an app that declares required args but no custom wording.
 * Apps should pass `missingArgsMessage` so the message names the id.
 */
const DEFAULT_MISSING_ARGS_MESSAGE =
  "The host did not provide the arguments this view needs.";

export interface UseHostRootOptions<TArgs> {
  /** App identity passed to the underlying `useApp` hook. */
  appInfo: { name: string; version: string };
  /**
   * Map raw tool input arguments to the app's typed args. Return `null` when
   * the input cannot be used (e.g. a required id is missing) — the host has
   * spoken, so that is an error, not a reason to keep waiting.
   */
  parseToolInput: (args: unknown) => TArgs | null;
  /**
   * Message surfaced when the host sends input that `parseToolInput` rejects.
   * Omit it only for an app whose args are all optional: without it a rejected
   * input is treated as "still waiting", which leaves an app that needs an id
   * on a permanent loading skeleton.
   */
  missingArgsMessage?: string;
  /** Display modes the app advertises. Defaults to inline + fullscreen. */
  capabilities?: McpUiAppCapabilities;
  /**
   * Tools this view exposes to the host and model. Declared here
   * rather than in the content component because `registerTool` only works
   * before `connect()`; the component installs the implementations with
   * `useViewTool`. See `viewTools.ts`.
   */
  viewTools?: readonly ViewToolDefinition[];
}

/** What one `ontoolinput` delivery means for the root's state. */
export type ToolInputOutcome<TArgs> =
  | { status: "ready"; toolArgs: TArgs }
  | { status: "unusable"; message: string }
  | { status: "ignored" };

/**
 * Decide what a tool input delivery means, given the app's parser. Pure and
 * exported so the three shapes (usable, unusable-with-required-args,
 * unusable-but-nothing-required) are unit-testable without a host.
 */
export function classifyToolInput<TArgs>(
  raw: unknown,
  parseToolInput: (args: unknown) => TArgs | null,
  missingArgsMessage?: string,
): ToolInputOutcome<TArgs> {
  const parsed = parseToolInput(raw);
  if (parsed !== null) return { status: "ready", toolArgs: parsed };
  // An app that declared no required args cannot be missing one: keep waiting
  // rather than inventing an error the user can do nothing about.
  if (missingArgsMessage === undefined) return { status: "ignored" };
  return {
    status: "unusable",
    message: missingArgsMessage || DEFAULT_MISSING_ARGS_MESSAGE,
  };
}

export interface HostRoot<TArgs> {
  /** Connected ext-apps `App`, or `null` until the handshake completes. */
  app: App | null;
  /** Host context subset that drives mobile detection and card chrome. */
  hostCtx: HostCtx;
  /** Resolved layout mode from `useMobileMode`. */
  mode: AppMode;
  /**
   * Parsed tool args, or `null` until the host sends usable input. An id the
   * host sent as `"latest"` is replaced by the id the tool result says it
   * resolved to, once that result arrives.
   */
  toolArgs: TArgs | null;
  /**
   * True while an id argument is `"latest"` and the tool result naming the
   * run has not arrived (for at most `LATEST_PIN_WAIT_MS`). `AppRootView`
   * keeps the skeleton up meanwhile, so no app fetches the word itself
   * moments before the pin lands.
   */
  pendingLatest: boolean;
  /** Connection error from the initialization handshake, if any. */
  connectError: Error | null;
  /**
   * Set once the host has sent tool input the app cannot use. Distinguishes
   * "waiting for host input" (both this and `toolArgs` null) from "host sent
   * input without the id", which must not sit on a skeleton forever.
   */
  argsError: string | null;
  /**
   * Registry the content component installs its view-tool handlers into, or
   * null when the app declared none.
   */
  viewToolRegistry: ViewToolRegistry | null;
}

/**
 * Owns the host-context scaffolding every MCP App needs at its root:
 * `useApp` wiring, tool-input parsing, host-context state plumbing,
 * `useHostStyles`, and mobile detection. Each app's `main.tsx` consumes
 * this instead of duplicating the `Root` boilerplate.
 */
export function useHostRoot<TArgs>({
  appInfo,
  parseToolInput,
  missingArgsMessage,
  capabilities = DEFAULT_CAPABILITIES,
  viewTools,
}: UseHostRootOptions<TArgs>): HostRoot<TArgs> {
  const [parsedArgs, setParsedArgs] = useState<TArgs | null>(null);
  const { toolArgs, pendingLatest, onToolResult } = useLatestPin(parsedArgs);
  const [argsError, setArgsError] = useState<string | null>(null);
  const [hostCtx, setHostCtx] = useState<HostCtx>({});

  // One registry per mount, created eagerly: `onAppCreated` fires during the
  // very first render's effect, before any state we could lazily initialise.
  const registryRef = useRef<ViewToolRegistry | null>(null);
  if (viewTools?.length && !registryRef.current) {
    registryRef.current = new ViewToolRegistry();
  }

  const { app, error: connectError } = useApp({
    appInfo,
    capabilities,
    onAppCreated: (createdApp) => {
      // The only window where this works: `useApp` calls `onAppCreated`
      // before `connect()`, and `registerTool` cannot advertise a capability
      // once the transport exists.
      if (viewTools?.length) {
        registryRef.current?.register(createdApp, viewTools);
      }
      createdApp.ontoolinput = (input) => {
        const outcome = classifyToolInput(
          input.arguments,
          parseToolInput,
          missingArgsMessage,
        );
        if (outcome.status === "ready") {
          setParsedArgs(outcome.toolArgs);
          setArgsError(null);
        } else if (outcome.status === "unusable") {
          setArgsError(outcome.message);
        }
      };
      // Registered before connect, like `ontoolinput`, so the result that
      // names a "latest" run is not missed.
      createdApp.ontoolresult = onToolResult;
      createdApp.onerror = console.error;
    },
  });

  useHostStyles(app, app?.getHostContext());

  // A host-context notification carries only the fields that changed. The
  // SDK merges it into `getHostContext()` before any listener runs, so read
  // the merged context. Storing the notification itself drops every field
  // the host did not send again.
  useEffect(() => {
    if (!app) return;
    const syncHostCtx = () => {
      const ctx = app.getHostContext();
      if (ctx) setHostCtx(pickHostCtx(ctx));
    };
    syncHostCtx();
    app.addEventListener("hostcontextchanged", syncHostCtx);
    return () => app.removeEventListener("hostcontextchanged", syncHostCtx);
  }, [app]);

  const isMobile = useMobileMode(hostCtx);
  const mode: AppMode = isMobile ? "mobile" : "desktop";

  return {
    app,
    hostCtx,
    mode,
    toolArgs,
    pendingLatest,
    connectError,
    argsError,
    viewToolRegistry: registryRef.current,
  };
}
