import {
  type App,
  type McpUiDisplayMode,
} from "@modelcontextprotocol/ext-apps";
import { type CSSProperties, type ReactNode, useState } from "react";
import styles from "./AppShell.module.css";
import { ErrorState } from "./ErrorState";
import {
  type AppMode,
  type HostRoot,
  type UseHostRootOptions,
  useHostRoot,
} from "./hostRoot";
import { type HostCtx } from "./useMobileMode";
import { type ViewToolRegistry } from "./viewTools";

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
 * error, unusable input, waiting for input (including the pin for
 * `"latest"`), connected. Split from `AppRoot`
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
  pendingLatest,
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
  // Waiting for the tool result that pins "latest" is still waiting for
  // input: the content (and so its fetch) must not start with the word.
  if (!app || toolArgs === null || pendingLatest) {
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
