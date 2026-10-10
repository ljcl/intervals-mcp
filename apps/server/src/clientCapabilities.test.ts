/**
 * Whether a request's client renders MCP Apps, and the view-* texts that
 * depend on it (#77).
 */
import { describe, expect, it } from "vitest";
import {
  clientSupportsMcpApps,
  MCP_APP_MIME_TYPE,
  viewFooter,
  viewTwinText,
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

describe("viewFooter", () => {
  it("keeps the rendered line for app hosts", () => {
    expect(viewFooter("training load chart", "get-training-load", true)).toBe(
      "[Interactive training load chart rendered above]",
    );
  });

  it("names the text twin otherwise", () => {
    expect(viewFooter("training load chart", "get-training-load", false)).toBe(
      "This client cannot display the interactive training load chart. For detail, call get-training-load.",
    );
  });
});

describe("viewTwinText", () => {
  it("says the client cannot display the chart, then gives the twin's text", () => {
    expect(
      viewTwinText(
        "zone distribution chart",
        "get-activity-zones",
        "Activity Zones (ID: 123):",
      ),
    ).toBe(
      "This client cannot display the interactive zone distribution chart. The same data from get-activity-zones follows.\n\nActivity Zones (ID: 123):",
    );
  });
});
