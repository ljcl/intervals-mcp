/**
 * What the calling client can display, read from the request envelope (#77).
 *
 * A view-* tool opens a chart through an MCP App, and a host that does not
 * render MCP Apps shows nothing for it. Its text used to say "rendered above"
 * regardless, so the model told the athlete about a chart that was never
 * there. The envelope's client capabilities say whether the host renders one.
 */

/** The MIME type an MCP App resource is served as, and a host advertises. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** ext-apps' EXTENSION_ID; read directly so the server does not depend on
 * the UI SDK (#77). */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * True only when the client advertised the MCP Apps extension with the MCP App
 * MIME type. Takes `unknown` because the shipped envelope type is `{}`.
 */
export function clientSupportsMcpApps(capabilities: unknown): boolean {
  const ext = (
    capabilities as { extensions?: Record<string, unknown> } | null | undefined
  )?.extensions?.[MCP_APPS_EXTENSION_ID] as { mimeTypes?: unknown } | undefined;
  return (
    Array.isArray(ext?.mimeTypes) && ext.mimeTypes.includes(MCP_APP_MIME_TYPE)
  );
}

/**
 * The last line of every view-* text: a rendered chart is claimed only to a
 * host that said it renders MCP Apps; any other host is told it cannot see the
 * chart and which text tool carries the same numbers. `twin` is the call to
 * make instead, starting with a tool name ("get-training-load with the same
 * arguments"); the app-handler tests check every name it gives is a real tool.
 */
export function viewFooter(
  kind: string,
  twin: string,
  rendersApps: boolean,
): string {
  return rendersApps
    ? `[Interactive ${kind} rendered above]`
    : `This client cannot display the interactive ${kind}. For detail, call ${twin}.`;
}

/**
 * The whole view-* text for a host that cannot render MCP Apps when the text
 * twin answered in the same call: one line that says so, then the twin's own
 * text, so the model has the chart's numbers without a second call. `twin` is
 * the tool name only.
 */
export function viewTwinText(
  kind: string,
  twin: string,
  twinText: string,
): string {
  return `This client cannot display the interactive ${kind}. The same data from ${twin} follows.\n\n${twinText}`;
}
