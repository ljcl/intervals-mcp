/**
 * Whether a request's client renders MCP Apps, and the view-* texts that
 * depend on it (#77).
 */
import { describe, expect, it } from "vitest";
import {
  clientSupportsMcpApps,
  MCP_APP_MIME_TYPE,
  viewHeader,
} from "./clientCapabilities";

const UI = "io.modelcontextprotocol/ui";

describe("clientSupportsMcpApps", () => {
  it("needs the ui extension with the MCP App mime type", () => {
    expect(
      clientSupportsMcpApps({
        extensions: { [UI]: { mimeTypes: ["text/html;profile=mcp-app"] } },
      }),
    ).toBe(true);
    expect(MCP_APP_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });

  it("is true when the mime type is one of several", () => {
    expect(
      clientSupportsMcpApps({
        extensions: {
          [UI]: { mimeTypes: ["text/plain", "text/html;profile=mcp-app"] },
        },
      }),
    ).toBe(true);
  });

  it("is false otherwise", () => {
    expect(clientSupportsMcpApps(undefined)).toBe(false);
    expect(clientSupportsMcpApps(null)).toBe(false);
    expect(clientSupportsMcpApps({})).toBe(false);
    expect(clientSupportsMcpApps({ extensions: {} })).toBe(false);
    expect(clientSupportsMcpApps({ extensions: { [UI]: {} } })).toBe(false);
    expect(
      clientSupportsMcpApps({
        extensions: { [UI]: { mimeTypes: ["text/html"] } },
      }),
    ).toBe(false);
    expect(
      clientSupportsMcpApps({
        extensions: { [UI]: { mimeTypes: "text/html;profile=mcp-app" } },
      }),
    ).toBe(false);
  });
});

describe("viewHeader", () => {
  it("says the chart is shown to a client that advertised MCP Apps", () => {
    expect(
      viewHeader(
        "training load chart",
        true,
        "The same data from get-training-load follows.",
      ),
    ).toBe(
      "Interactive training load chart shown. The same data from get-training-load follows.",
    );
  });

  it("never says cannot display to any other client, because its host may still render the card", () => {
    const text = viewHeader("route map", false, "Its data follows.");
    expect(text).toBe(
      "This client did not report MCP Apps support, so the interactive route map may not show. Its data follows.",
    );
    expect(text).not.toContain("cannot display");
  });
});
