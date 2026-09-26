import { type App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useState } from "react";
import { parseTextContent, progressCallOptions } from "./serverToolResult";

export interface ServerToolData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * Latest progress message from the server, or null when the tool has sent
   * none. Only meaningful while `loading`.
   */
  progress: string | null;
  /** Re-invokes the fetch (wired to the ErrorState retry control). */
  retry: () => void;
}

/**
 * Fetch/loading/error state machine for the app-only data tools every MCP
 * App calls on mount, so no app hand-rolls the ~40 lines in its own main.tsx.
 * The response convention is the server's app-data one: JSON in the first
 * text content block.
 *
 * `args` may be an inline object literal; the fetch is keyed on its JSON
 * serialization, so a new-but-equal object does not refetch.
 *
 * Progress: the tools behind training-load, fitness-trend, and
 * cadence-trends page through an athlete's history and can outrun the host's
 * default request timeout on a long one. `resetTimeoutOnProgress` restarts
 * that clock on every notification, so a scan that is still working is not
 * killed for taking a while, and the message it carries replaces a skeleton
 * that says nothing with one that says what is happening.
 */
export function useServerToolData<T>(
  app: App | null,
  toolName: string,
  args: Record<string, unknown>,
): ServerToolData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const argsKey = JSON.stringify(args);

  const fetchData = useCallback(async () => {
    if (!app) return;
    try {
      setLoading(true);
      setError(null);
      // A retry starts from no progress rather than the stale message of the
      // attempt that failed.
      setProgress(null);
      const result = await app.callServerTool(
        {
          name: toolName,
          arguments: JSON.parse(argsKey) as Record<string, unknown>,
        },
        progressCallOptions(setProgress),
      );
      const parsed = parseTextContent<T>(result, toolName);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setData(parsed.data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [app, toolName, argsKey]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, progress, retry: () => void fetchData() };
}
