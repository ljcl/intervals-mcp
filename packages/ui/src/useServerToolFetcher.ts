import { type App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { type KeyedFetchState, KeyedFetchStore } from "./keyedFetchStore";
import { parseTextContent, progressCallOptions } from "./serverToolResult";

export interface ServerToolFetcher<T> {
  /** Per-key state; a key absent from the map has never been requested. */
  entries: ReadonlyMap<string, KeyedFetchState<T>>;
  /** Fetch `key` unless it is already loaded, in flight, or failed. */
  request: (key: string) => void;
  /** Fetch `key` again after a failure — wire this to the retry control. */
  retry: (key: string) => void;
}

/**
 * `useServerToolData`'s sibling for the on-demand case: many payloads from
 * one tool, fetched as the user asks for them, each with its own loading,
 * error, and retry. `useServerToolData` covers the mount-time single
 * fetch; anything keyed — a stream per selected run — belongs here rather
 * than in a hand-rolled effect.
 *
 * `buildArgs` maps a key to that call's arguments and is read through a ref,
 * so an inline arrow does not tear down the store on every render.
 *
 * Progress: each call passes the same options as `useServerToolData`. A slow
 * call that sends progress is not killed by the host's request timeout, and
 * the latest message lands on that key's `progress` for `LoadingState` to
 * show.
 */
export function useServerToolFetcher<T>(
  app: App | null,
  toolName: string,
  buildArgs: (key: string) => Record<string, unknown>,
): ServerToolFetcher<T> {
  const buildArgsRef = useRef(buildArgs);
  buildArgsRef.current = buildArgs;

  const store = useMemo(
    () =>
      new KeyedFetchStore<T>(async (key, onProgress) => {
        if (!app) throw new Error(`Not connected to the host`);
        const result = await app.callServerTool(
          { name: toolName, arguments: buildArgsRef.current(key) },
          progressCallOptions(onProgress),
        );
        const parsed = parseTextContent<T>(result, toolName);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.data;
      }),
    [app, toolName],
  );

  const entries = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // Requests made before the handshake completes are dropped rather than
  // recorded as failures; the caller's effect re-requests once `app` lands.
  const request = useCallback(
    (key: string) => {
      if (app) store.request(key);
    },
    [app, store],
  );

  const retry = useCallback(
    (key: string) => {
      if (app) store.retry(key);
    },
    [app, store],
  );

  return { entries, request, retry };
}
