import {
  type App,
  type McpUiAppCapabilities,
  type McpUiDisplayMode,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./AppShell.module.css";
import { ErrorState } from "./ErrorState";
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
  /** Parsed tool args, or `null` until the host sends usable input. */
  toolArgs: TArgs | null;
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
  const [toolArgs, setToolArgs] = useState<TArgs | null>(null);
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
          setToolArgs(outcome.toolArgs);
          setArgsError(null);
        } else if (outcome.status === "unusable") {
          setArgsError(outcome.message);
        }
      };
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
    connectError,
    argsError,
    viewToolRegistry: registryRef.current,
  };
}

/** Compute the outer card chrome (safe-area insets, margin, width clamp). */
function cardStyle(hostCtx: HostCtx, mode: AppMode): CSSProperties {
  const safeAreaInsets = hostCtx.safeAreaInsets;
  const basePad = mode === "mobile" ? { y: 16, x: 14 } : { y: 24, x: 20 };
  // Small outer margin on mobile so the card's border isn't clipped by
  // the host iframe edge (seen on Claude iOS where the chat card gives
  // the app iframe zero surrounding padding).
  const outerMargin = mode === "mobile" ? 3 : 0;

  return {
    boxSizing: "border-box",
    // Anchor for the absolutely-positioned fullscreen toggle.
    position: "relative",
    // Always fill the iframe minus the outer margin so nothing inside
    // can force the card wider than the host viewport (the cause of
    // the horizontal scroll we saw on Claude iOS).
    width: `calc(100% - ${outerMargin * 2}px)`,
    margin: outerMargin,
    background: "var(--color-background-primary)",
    border: "1px solid var(--color-border-tertiary)",
    borderRadius: "var(--border-radius-lg)",
    paddingBottom: `calc(${basePad.y}px + ${safeAreaInsets?.bottom ?? 0}px)`,
    paddingLeft: `calc(${basePad.x}px + ${safeAreaInsets?.left ?? 0}px)`,
    paddingRight: `calc(${basePad.x}px + ${safeAreaInsets?.right ?? 0}px)`,
    paddingTop: `calc(${basePad.y}px + ${safeAreaInsets?.top ?? 0}px)`,
    overflow: "hidden",
  };
}

/**
 * The one `App` method the fullscreen toggle needs, kept structural so
 * stories and tests can pass a two-line fake instead of a connected app.
 */
export interface DisplayModeApp {
  requestDisplayMode(params: {
    mode: McpUiDisplayMode;
  }): Promise<{ mode: McpUiDisplayMode }>;
}

const EXPAND_PATH = "M9 1h4v4M13 1L8.5 5.5M5 13H1V9M1 13l4.5-4.5";
const COMPRESS_PATH = "M13 5H9V1M9 5l4.5-4.5M1 9h4v4M5 9L.5 13.5";

interface FullscreenToggleProps {
  app: DisplayModeApp;
  hostCtx: HostCtx;
}

/**
 * Enter/exit-fullscreen control. It shows the display mode that the host
 * reports. After a request, it shows the mode that `requestDisplayMode`
 * returned instead. This local echo covers hosts that grant a request
 * without re-sending context. The next mode that the host reports replaces
 * the echo.
 */
function FullscreenToggle({ app, hostCtx }: FullscreenToggleProps) {
  const [localMode, setLocalMode] = useState<McpUiDisplayMode | null>(null);
  // Drop the echo when the host reports a new mode. Doing this during render,
  // not in an effect, keeps a stale echo off the screen.
  const [lastHostMode, setLastHostMode] = useState(hostCtx.displayMode);
  if (hostCtx.displayMode !== lastHostMode) {
    setLastHostMode(hostCtx.displayMode);
    setLocalMode(null);
  }
  const displayMode = localMode ?? hostCtx.displayMode ?? "inline";
  const isFullscreen = displayMode === "fullscreen";

  const toggle = async () => {
    const next: McpUiDisplayMode = isFullscreen ? "inline" : "fullscreen";
    try {
      const result = await app.requestDisplayMode({ mode: next });
      setLocalMode(result.mode);
    } catch {
      // Host declined or errored; keep showing the current state.
    }
  };

  return (
    <button
      type="button"
      className={styles.fullscreenToggle}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      aria-pressed={isFullscreen}
      onClick={toggle}
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d={isFullscreen ? COMPRESS_PATH : EXPAND_PATH} />
      </svg>
    </button>
  );
}

export interface AppShellProps {
  hostCtx: HostCtx;
  mode: AppMode;
  children: ReactNode;
  /**
   * Connected app (or a `DisplayModeApp` fake). When provided AND the host
   * advertises fullscreen in `availableDisplayModes`, the card renders the
   * shared fullscreen toggle in its top-right corner.
   */
  app?: DisplayModeApp | null;
}

/**
 * Outer card shell shared by every MCP App. Wraps content in the bordered
 * card with safe-area-aware padding, outer margin, and width clamp that
 * the host chrome rules in docs/mcp-apps.md depend on staying identical. With an
 * `app` and a fullscreen-capable host it also owns the display-mode toggle,
 * so every app gets the control at once.
 */
export function AppShell({ hostCtx, mode, children, app }: AppShellProps) {
  const canFullscreen =
    app != null &&
    (hostCtx.availableDisplayModes?.includes("fullscreen") ?? false);
  return (
    <div style={cardStyle(hostCtx, mode)}>
      {canFullscreen && <FullscreenToggle app={app} hostCtx={hostCtx} />}
      {children}
    </div>
  );
}

/** `HostRoot` narrowed to the connected, args-in-hand case `AppRoot` renders. */
export interface ConnectedHostRoot<TArgs> {
  app: App;
  hostCtx: HostCtx;
  mode: AppMode;
  toolArgs: TArgs;
  /** Where the content component installs its `useViewTool` handlers. */
  viewToolRegistry: ViewToolRegistry | null;
}

export interface AppRootViewProps<TArgs> extends HostRoot<TArgs> {
  /** Skeleton shown while connecting and waiting for the host's tool input. */
  loading: ReactNode;
  /** Rendered once the app is connected and the tool input parsed. */
  children: (root: ConnectedHostRoot<TArgs>) => ReactNode;
}

/**
 * The pre-content state machine, as a pure function of `HostRoot`: connect
 * error, unusable input, waiting for input, connected. Split from `AppRoot`
 * so every branch is renderable without a live host — the story smoke tests
 * and their axe checks are what hold the convention in place.
 *
 * Each pre-content state renders inside the same `AppShell` as the loaded app
 * so the card chrome is stable from first paint.
 */
export function AppRootView<TArgs>({
  app,
  hostCtx,
  mode,
  toolArgs,
  connectError,
  argsError,
  viewToolRegistry,
  loading,
  children,
}: AppRootViewProps<TArgs>) {
  if (connectError) {
    return (
      <AppShell hostCtx={hostCtx} mode={mode}>
        <ErrorState message={`Connection error: ${connectError.message}`} />
      </AppShell>
    );
  }
  // Ahead of the waiting branch: unusable input leaves `toolArgs` null, and
  // waiting on a skeleton for input that already arrived never resolves.
  if (argsError) {
    return (
      <AppShell hostCtx={hostCtx} mode={mode}>
        <ErrorState message={argsError} />
      </AppShell>
    );
  }
  if (!app || toolArgs === null) {
    return (
      <AppShell hostCtx={hostCtx} mode={mode}>
        {loading}
      </AppShell>
    );
  }

  return <>{children({ app, hostCtx, mode, toolArgs, viewToolRegistry })}</>;
}

export interface AppRootProps<TArgs> extends UseHostRootOptions<TArgs> {
  /** Skeleton shown while connecting and waiting for the host's tool input. */
  loading: ReactNode;
  /** Rendered once the app is connected and the tool input parsed. */
  children: (root: ConnectedHostRoot<TArgs>) => ReactNode;
}

/**
 * Root every MCP App's `main.tsx` mounts: connects to the host, then renders
 * the shared state machine above. Centralising both is what stops the eight
 * apps re-litigating what a missing id should look like.
 *
 * `children` is a render prop rather than an element so it only runs once the
 * app and args are non-null — the content component never re-checks them.
 */
export function AppRoot<TArgs>({
  loading,
  children,
  ...options
}: AppRootProps<TArgs>) {
  const root = useHostRoot<TArgs>(options);
  return (
    <AppRootView {...root} loading={loading}>
      {children}
    </AppRootView>
  );
}
