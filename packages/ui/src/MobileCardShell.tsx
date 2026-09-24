import { type ReactNode } from "react";
import { AppShell } from "./AppShell";

/**
 * Storybook decorator body for `claudeIosCard` mobile stories: renders the
 * story inside the REAL `AppShell` with a mobile host context, so previews
 * carry exactly the chrome that ships in the host iframe — width clamp,
 * safe-area-aware padding, 3px outer margin, and overflow clipping. The
 * hand-rolled copies this replaces had drifted (no width clamp, no
 * safe-area padding).
 *
 * Lives in `@intervals-mcp/ui` rather than the design-system preview module
 * because `AppShell` is a ui component and design-system sits below ui in
 * the package boundary graph.
 */
export function MobileCardShell({ children }: { children: ReactNode }) {
  return (
    <AppShell hostCtx={{}} mode="mobile">
      {children}
    </AppShell>
  );
}
