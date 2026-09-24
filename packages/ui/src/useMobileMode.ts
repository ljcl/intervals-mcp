import { MOBILE_BREAKPOINT_PX } from "@intervals-mcp/design-system";
import { type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useSyncExternalStore } from "react";

/**
 * Width (in px) below which we render the mobile layout. Re-exported from
 * design-system so existing `@intervals-mcp/ui` consumers keep working.
 *
 * Design-system owns the value (see
 * `packages/design-system/src/chart-tokens.ts`). The detection heuristic
 * lives in this file.
 */
export { MOBILE_BREAKPOINT_PX };

export type HostCtx = Pick<
  McpUiHostContext,
  | "platform"
  | "containerDimensions"
  | "safeAreaInsets"
  | "deviceCapabilities"
  | "userAgent"
  | "displayMode"
  | "availableDisplayModes"
>;

/**
 * Extract a width hint (in px) from host-reported container dimensions.
 * Supports both fixed `width` and bounded `maxWidth` forms per the MCP
 * Apps spec.
 */
export function widthFromHost(
  dims: McpUiHostContext["containerDimensions"],
): number | undefined {
  if (!dims) return undefined;
  if ("width" in dims && typeof dims.width === "number") return dims.width;
  if ("maxWidth" in dims && typeof dims.maxWidth === "number")
    return dims.maxWidth;
  return undefined;
}

/**
 * Subscribe to window.innerWidth so we re-render when the iframe is
 * resized. This is our most reliable mobile signal when the host doesn't
 * populate `platform` or `containerDimensions` (e.g. current Claude iOS
 * builds).
 */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener("resize", notify);
      return () => window.removeEventListener("resize", notify);
    },
    () => window.innerWidth,
    () => MOBILE_BREAKPOINT_PX + 1,
  );
}

/**
 * Decide whether to render the mobile layout. Combines every signal the
 * host is willing to give us:
 *
 * 1. Explicit `platform === "mobile"` (strongest)
 * 2. Touch-only device (touch && !hover) via deviceCapabilities
 * 3. Host-reported container width/maxWidth under the breakpoint
 * 4. Actual iframe `window.innerWidth` under the breakpoint (fallback)
 * 5. UA sniff for iPhone/iPad/Android (last resort)
 *
 * Any single signal triggers mobile. This is intentional: falsely
 * rendering mobile on desktop is a minor cosmetic issue, but falsely
 * rendering desktop on mobile squishes charts into an unreadable state.
 */
export function detectMobile(host: HostCtx, viewportWidth: number): boolean {
  if (host.platform === "mobile") return true;

  const caps = host.deviceCapabilities;
  if (caps?.touch === true && caps?.hover === false) return true;

  const hostWidth = widthFromHost(host.containerDimensions);
  if (hostWidth !== undefined && hostWidth < MOBILE_BREAKPOINT_PX) return true;

  if (viewportWidth < MOBILE_BREAKPOINT_PX) return true;

  const ua =
    host.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "") ??
    "";
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;

  return false;
}

/**
 * Composed hook: derives the current mobile mode from the host context
 * and the live viewport width. Returns `true` when the app should
 * render its mobile layout.
 */
export function useMobileMode(host: HostCtx): boolean {
  const viewportWidth = useViewportWidth();
  return detectMobile(host, viewportWidth);
}
