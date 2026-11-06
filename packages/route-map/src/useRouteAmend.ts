import { useRef, useState } from "react";
import {
  type AmendOperation,
  type AmendRequest,
  type AmendToolResult,
  describeOperation,
  fallbackMessage,
  readAmendResult,
} from "./routeEdit";
import { type RouteMapRoute } from "./types";

/**
 * The part of the ext-apps `App` a route edit uses. Structural, so the real
 * App and a test double both fit.
 */
export interface RouteEditApp {
  callServerTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<AmendToolResult>;
  sendMessage(params: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }): Promise<{ isError?: boolean }>;
  getHostCapabilities(): { message?: unknown } | undefined;
}

/** What the edit controls show under them after a call. */
export interface EditNotice {
  tone: "info" | "success" | "warning" | "error";
  text: string;
}

export interface RouteAmend {
  /** True while a change is with the server (or the chat). */
  busy: boolean;
  notice: EditNotice | null;
  amend: (op: AmendOperation) => void;
}

/**
 * Sends one map edit to amend-route, from the shown version (which must be
 * the latest), and says what happened. A new version goes to `onApplied`,
 * which loads it. A client that may not run writes (the server refuses a
 * 2025-revision client), or a call that fails in transport, sends the same
 * operations to the chat as a user message when the host takes messages.
 * In that case the note says the chat will make the change, never that it
 * is made; amend-route refuses a second copy, because its base version is
 * then no longer the latest.
 */
export function useRouteAmend(
  app: RouteEditApp | undefined,
  route: RouteMapRoute | undefined,
  onApplied: (version: number, summary: string) => void,
): RouteAmend {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<EditNotice | null>(null);
  // A second tap before the first state update lands must not send twice.
  const inFlight = useRef(false);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  const askChat = async (
    host: RouteEditApp,
    request: AmendRequest,
    op: AmendOperation,
  ): Promise<EditNotice> => {
    const cannot = "This host cannot change the route from the map.";
    if (!host.getHostCapabilities()?.message) {
      return {
        tone: "error",
        text: `${cannot} Ask in the chat: ${describeOperation(op)}.`,
      };
    }
    try {
      const sent = await host.sendMessage({
        role: "user",
        content: [{ type: "text", text: fallbackMessage(request) }],
      });
      if (!sent.isError) {
        return {
          tone: "info",
          text: `${cannot} The change went to the chat, which will apply it. The map does not show it until then.`,
        };
      }
    } catch {
      // Fall through to the note below.
    }
    return {
      tone: "error",
      text: `${cannot} The message to the chat failed too. Ask in the chat: ${describeOperation(op)}.`,
    };
  };

  const run = async (op: AmendOperation) => {
    if (!app || !route) return;
    const request: AmendRequest = {
      route_id: route.route_id,
      base_version: route.version,
      operations: [op],
    };
    let result: AmendToolResult | null;
    try {
      result = await app.callServerTool({
        name: "amend-route",
        arguments: { ...request },
      });
    } catch {
      result = null;
    }
    const outcome = result
      ? readAmendResult(result, route.route_id)
      : ({ kind: "legacy_refused", text: "" } as const);
    switch (outcome.kind) {
      case "applied":
        setNotice({
          tone: "success",
          text: [outcome.summary, ...outcome.warnings].join(" "),
        });
        onAppliedRef.current(outcome.version, outcome.summary);
        return;
      case "not_applied":
        setNotice({ tone: "warning", text: outcome.warnings.join(" ") });
        return;
      case "error":
        setNotice({ tone: "error", text: outcome.text });
        return;
      case "legacy_refused":
        setNotice(await askChat(app, request, op));
        return;
    }
  };

  const amend = (op: AmendOperation) => {
    if (inFlight.current || !app || !route?.editable) return;
    inFlight.current = true;
    setBusy(true);
    setNotice({ tone: "info", text: `${describeOperation(op)}…` });
    void run(op).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };

  return { busy, notice, amend };
}
