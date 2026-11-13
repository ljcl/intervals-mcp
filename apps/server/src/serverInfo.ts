import { SERVER_VERSION } from "./version";

/**
 * The server's icon: four bars, work and rest, on a rounded square (#416).
 * Hosts that draw a connector icon showed a placeholder without one.
 *
 * It is inline, not a URL: the server often has no public address
 * (`PUBLIC_URL` is optional), and a host may refuse to fetch an icon from a
 * different origin. Every result's `_meta` repeats the server info, so the
 * icon stays one small SVG; `serverInfo.test.ts` holds it under a budget.
 */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#0f766e"/>' +
  '<g fill="#fff">' +
  '<rect x="12" y="14" width="7" height="36" rx="2"/>' +
  '<rect x="23" y="36" width="7" height="14" rx="2"/>' +
  '<rect x="34" y="14" width="7" height="36" rx="2"/>' +
  '<rect x="45" y="36" width="7" height="14" rx="2"/>' +
  "</g></svg>";

/** The icon as a `data:` URI, the form an MCP icon's `src` takes inline. */
export const SERVER_ICON_SRC = `data:image/svg+xml;base64,${Buffer.from(
  ICON_SVG,
).toString("base64")}`;

/** The repository README, the same `websiteUrl` server.json gives the registry. */
export const SERVER_WEBSITE_URL =
  "https://github.com/ljcl/intervals-mcp#readme";

/**
 * The implementation info `createServer` sends: in `server/discover`, on every
 * result's `_meta`, and in a 2025-era `initialize`.
 */
export const SERVER_INFO = {
  name: "Intervals Extra",
  title: "Intervals Extra (intervals.icu)",
  version: SERVER_VERSION,
  websiteUrl: SERVER_WEBSITE_URL,
  icons: [{ src: SERVER_ICON_SRC, mimeType: "image/svg+xml", sizes: ["any"] }],
};
