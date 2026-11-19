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
 * True when the client advertised form-mode elicitation: an `elicitation`
 * capability that names `form`, or names no mode at all, which the spec
 * reads as form only. URL mode alone does not count: a host-rendered
 * confirmation of a write needs a form (#417). Takes `unknown` like
 * {@link clientSupportsMcpApps}.
 */
export function clientSupportsFormElicitation(capabilities: unknown): boolean {
  const elicitation = (
    capabilities as { elicitation?: unknown } | null | undefined
  )?.elicitation;
  if (
    typeof elicitation !== "object" ||
    elicitation === null ||
    Array.isArray(elicitation)
  ) {
    return false;
  }
  const modes = elicitation as { form?: unknown; url?: unknown };
  return modes.form !== undefined || modes.url === undefined;
}

/**
 * The first line of every view-* text. A chart is claimed as shown only to
 * a client that advertised MCP Apps. Any other client gets a line that is
 * true either way: a host can render the card for a client that did not
 * advertise the extension (the Claude app does, for a cloud agent session),
 * so "cannot display" was wrong there (docs/architecture.md, "Telemetry").
 * Either way the view's data follows, so the model never needs a second
 * call for the numbers. `then` says what follows ("The same data from
 * get-training-load follows.").
 */
export function viewHeader(
  kind: string,
  rendersApps: boolean,
  then: string,
): string {
  return rendersApps
    ? `Interactive ${kind} shown. ${then}`
    : `This client did not report MCP Apps support, so the interactive ${kind} may not show. ${then}`;
}
