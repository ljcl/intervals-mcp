/**
 * The MCP registry proves ownership of the OCI package by pulling the image
 * and reading its `io.modelcontextprotocol.server.name` label, which must
 * equal `name` in `server.json`. The Dockerfile comment asked for the two to
 * stay in sync; this makes it a check (#91), because a mismatch only surfaces
 * as a registry rejection after the tag and the image have shipped.
 *
 * The package identifier embeds the image tag, which release-please cannot
 * template, so publish-mcp.yml stamps `ghcr.io/<repo>:<version>` at publish
 * time. The in-repo value is a placeholder tag that exists on no image: a
 * manual `mcp-publisher publish` from a checkout then fails the registry's
 * pull instead of registering a stale image, as the old `:0.1.0` would have.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC_DIR = new URL(".", import.meta.url);
const SERVER_JSON_URL = new URL("../../../server.json", SRC_DIR);
const DOCKERFILE_URL = new URL("../Dockerfile", SRC_DIR);

const IDENTIFIER_PLACEHOLDER_TAG = "stamped-at-publish";

interface ServerJson {
  name: string;
  repository: { url: string };
  packages: { registryType: string; identifier: string }[];
}

const serverJson = JSON.parse(
  readFileSync(SERVER_JSON_URL, "utf8"),
) as ServerJson;

describe("server.json", () => {
  it("names the server the way the image label does", () => {
    const dockerfile = readFileSync(DOCKERFILE_URL, "utf8");
    const label =
      /^LABEL io\.modelcontextprotocol\.server\.name="([^"]+)"/m.exec(
        dockerfile,
      )?.[1];
    expect(label, "no server-name LABEL in the Dockerfile").toBeDefined();
    expect(label).toBe(serverJson.name);
  });

  it("carries the placeholder image tag that publish-mcp.yml stamps", () => {
    // publish-mcp.yml stamps ghcr.io/${{ github.repository }}, so the image
    // path has to be this repository's.
    const repo = new URL(serverJson.repository.url).pathname.replace(/^\//, "");
    const oci = serverJson.packages.filter((p) => p.registryType === "oci");
    expect(oci).toHaveLength(1);
    expect(oci[0]!.identifier).toBe(
      `ghcr.io/${repo}:${IDENTIFIER_PLACEHOLDER_TAG}`,
    );
  });
});
