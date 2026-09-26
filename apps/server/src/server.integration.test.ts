/**
 * The MCP protocol surface, asserted through the real server (#270).
 *
 * Every other server suite enters below the protocol layer — calling
 * `dispatchToolCall` directly, or building a throwaway `new Server()` with no
 * tools on it. That leaves the wiring between transport and handlers
 * unverified: a dropped `setRequestHandler`, an input schema that serialises
 * to something a host cannot generate against, or a broken app-resource
 * template would all ship green.
 *
 * So these drive real requests through the endpoint and assert the JSON that comes back. The
 * suite is deliberately the last piece of epic #284, so it asserts the
 * finished surface — the output schemas, the `logging` capability, and the
 * progress plumbing — rather than being amended three times on the way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTimeZone } from "./config";
import { getActivity } from "./intervalsClient";
import { INTERVALS_ID_HINT } from "./tools/_ids";

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return { ...actual, getActivity: vi.fn() };
});

// Dispatch resolves the key before any handler runs (#240), so without this
// an end-to-end tools/call reads process.env directly.
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { connectTestClient } = await import("./mcpTestClient");
const { TOOL_DEFS } = await import("./server");

const mockedIntervalsActivity = vi.mocked(getActivity);

/**
 * Claude Code cuts a tool description at 2,048 characters, so the end of a
 * longer one never reaches the model (#39). The cap leaves headroom below it.
 */
const MAX_TOOL_DESCRIPTION_CHARS = 1800;

/**
 * The server instructions reach the model at the start of every chat, so they
 * get the same budget as one tool description (#38).
 */
const MAX_INSTRUCTIONS_CHARS = 1800;

/** A tool name as a description mentions one, e.g. "use get-fitness-trend". */
const TOOL_NAME_MENTION =
  /\b(?:get|list|view|compare|update)-[a-z]+(?:-[a-z]+)*\b/g;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("server/discover", () => {
  it("advertises the 2026-07-28 revision and every capability the server implements", async () => {
    const { discover } = await connectTestClient("discover-test");

    expect(discover.supportedVersions).toEqual(["2026-07-28"]);
    expect(discover.capabilities).toMatchObject({
      tools: expect.any(Object),
      resources: expect.any(Object),
      prompts: expect.any(Object),
      logging: expect.any(Object),
    });
  });

  it("names the server with a display title", async () => {
    const { discover } = await connectTestClient("discover-title-test");
    const meta = discover._meta as Record<string, unknown> | undefined;

    expect(meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "Intervals Extra",
      title: expect.stringMatching(/\S/),
      version: expect.any(String),
    });
  });

  it("sends instructions that fit the budget and route only to real tools", async () => {
    const client = await connectTestClient("discover-instructions-test");
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<{ name: string }>;
    const names = new Set(tools.map((tool) => tool.name));
    const instructions = client.discover.instructions;

    expect(typeof instructions).toBe("string");
    const text = instructions as string;
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(text).toContain(getTimeZone());
    // A renamed or removed tool must not leave the orientation sending every
    // chat to an unknown-tool error.
    const mentioned = text.match(TOOL_NAME_MENTION) ?? [];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(names.has(name), `instructions mention ${name}`).toBe(true);
    }
  });
});

describe("result envelope", () => {
  it("stamps resultType, cache fields, and server identity on tools/list", async () => {
    const client = await connectTestClient("envelope-test");
    const { result } = await client.send("tools/list");

    // Every 2026-07-28 result is discriminated...
    expect(result?.resultType).toBe("complete");
    // ...list results carry the required CacheableResult fields, resolved
    // from `cacheHints` (the static surface only changes on redeploy)...
    expect(result?.ttlMs).toBe(60 * 60 * 1000);
    expect(result?.cacheScope).toBe("private");
    // ...and the server identifies itself on each response instead of once
    // in an initialize handshake.
    const meta = result?._meta as Record<string, unknown>;
    expect(meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: expect.any(String),
      version: expect.any(String),
    });
  });

  it("rejects an envelope naming a revision the endpoint does not serve", async () => {
    const client = await connectTestClient("envelope-test");

    const raw = await client.sendRaw("tools/list", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
    });

    // -32022: UnsupportedProtocolVersion, the typed answer.
    expect(raw).toContain("-32022");
  });
});

/**
 * Every input field naming an intervals.icu activity id, in each spelling the
 * surface uses: `id`, `activity_id`, `activity_id_1`, `activityId`,
 * `activityId2`. The narrower `/(^|_)(id|Id)$/` this replaced matched only
 * the first two, skipping 28 of the 43 id arguments: the camelCase and
 * numbered ones, including all four tools that were still hand-rolling their
 * id schema.
 */
const ID_FIELD = /(^|_)id(_\d+)?$|Id\d*$/;

/** Id arguments across the advertised surface when this floor was set. */
const ID_FIELD_COUNT = 23;

/**
 * Gear ids are alphanumeric (`g123456`), not digit strings, so they are the
 * one id argument `intervalsActivityIdInput` does not serve.
 */
const NON_NUMERIC_ID_FIELDS = new Set(["gearId"]);

interface AdvertisedIdField {
  tool: string;
  field: string;
  prop: { type?: unknown; pattern?: unknown; description?: string };
}

/** Every id argument as a host sees it, flattened across tools/list. */
async function advertisedIdFields(): Promise<AdvertisedIdField[]> {
  const client = await connectTestClient();
  const { result } = await client.send("tools/list");
  const tools = result?.tools as Array<Record<string, unknown>>;

  const fields: AdvertisedIdField[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
    };
    for (const [field, raw] of Object.entries(schema.properties ?? {})) {
      if (!ID_FIELD.test(field)) continue;
      fields.push({
        tool: String(tool.name),
        field,
        prop: raw as AdvertisedIdField["prop"],
      });
    }
  }
  return fields;
}

describe("tools/list", () => {
  it("returns every advertised tool", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(TOOL_DEFS.length);
  });

  it("keeps every description whole in Claude Code and pointing at real tools", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<{ name: string; description: string }>;
    const names = new Set(tools.map((tool) => tool.name));

    for (const { name, description } of tools) {
      expect(description, `${name} description is trimmed`).toBe(
        description.trim(),
      );
      expect(
        description.length,
        `${name} description length`,
      ).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
      // Each field's .describe() text already reaches the host in the
      // inputSchema; repeating it here only spends the cap.
      expect(description, `${name} repeats its inputs`).not.toMatch(
        /^Parameters:/m,
      );
      // Routing advice ("use get-fitness-trend instead") must name a tool
      // that exists, or it sends the model to an unknown-tool error.
      for (const mentioned of description.match(TOOL_NAME_MENTION) ?? []) {
        expect(names.has(mentioned), `${name} mentions ${mentioned}`).toBe(
          true,
        );
      }
    }
  });

  it("gives every tool its own display title", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<{ name: string; title?: unknown }>;

    // A host that shows titles shows them in place of the tool ids, so each
    // must be there and must tell the tools apart.
    for (const { name, title } of tools) {
      expect(title, `${name} title`).toEqual(expect.stringMatching(/\S/));
    }
    const titles = tools.map((tool) => tool.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("gives every tool a well-formed object inputSchema", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;

    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown> | undefined;
      expect(schema, `${String(tool.name)} has no inputSchema`).toBeTruthy();
      // A host generates arguments against this; anything but an object
      // schema with a properties bag is unusable to it.
      expect(schema?.type, `${String(tool.name)} inputSchema.type`).toBe(
        "object",
      );
      expect(
        typeof schema?.properties,
        `${String(tool.name)} inputSchema.properties`,
      ).toBe("object");
      // $ref/$defs would have to be resolved by the host against a schema
      // document it never receives.
      expect(JSON.stringify(schema)).not.toContain("$ref");
    }
  });

  it("keeps every published outputSchema an object schema too", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;

    const withOutput = tools.filter((t) => t.outputSchema);
    // The epic's schema batch published these; a caller branches on
    // `structuredContent` against them.
    expect(withOutput.length).toBeGreaterThan(0);
    for (const tool of withOutput) {
      const schema = tool.outputSchema as Record<string, unknown>;
      expect(schema.type, `${String(tool.name)} outputSchema.type`).toBe(
        "object",
      );
    }
  });

  it("advertises intervals.icu activity ids as strings, never as numbers", async () => {
    const ids = await advertisedIdFields();

    // Activity ids already exceed 2^53, so a host that generates a JSON
    // number loses digits before validation can see them.
    for (const { tool, field, prop } of ids) {
      expect(prop.type, `${tool}.${field} must be advertised as a string`).toBe(
        "string",
      );
    }
    // A floor, not an equality, so a new tool's id does not fail here — but a
    // filter that stops matching cannot pass on an empty set. The predecessor
    // of `ID_FIELD` matched 15 of these 43 and was green the whole time.
    expect(ids.length, "id arguments checked").toBeGreaterThanOrEqual(
      ID_FIELD_COUNT,
    );
  });

  it("routes every numeric id through intervalsActivityIdInput", async () => {
    const ids = await advertisedIdFields();

    // Advertising `type: "string"` is only half the convention:
    // `intervalsActivityIdInput` also accepts a safe-integer number at
    // runtime and normalises it, so a host emitting `routeId: 12345` is not
    // left stuck on "expected string, received number" (#282). A hand-rolled
    // `z.string().regex(/^\d+$/)` serialises to the same shape while
    // rejecting that call, so the hint appended to every id's description is
    // what distinguishes it here: `intervalsActivityIdInput`'s own hint,
    // matched at the end of the description so a copy of it would not
    // accidentally pass.
    for (const { tool, field, prop } of ids) {
      if (NON_NUMERIC_ID_FIELDS.has(field)) continue;
      const description = prop.description ?? "";
      expect(
        description.endsWith(INTERVALS_ID_HINT),
        `${tool}.${field} must use intervalsActivityIdInput`,
      ).toBe(true);
      expect(prop.pattern, `${tool}.${field} pattern`).toBe("^i?\\d+$");
    }
  });
});

describe("tools/call", () => {
  it("round-trips a tool's content through the transport", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "229781",
      name: "Hawk Hill",
      type: "Run",
      start_date_local: "2026-09-20T09:00:00",
      icu_intervals: [],
    } as never);

    const client = await connectTestClient();
    const { result, error } = await client.send("tools/call", {
      name: "get-activity-laps",
      arguments: { id: "229781" },
    });

    expect(error).toBeUndefined();
    const content = result?.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("229781");
  });

  it("delivers structuredContent alongside the text", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "229781",
      name: "Hawk Hill",
      type: "Run",
      start_date_local: "2026-09-20T09:00:00",
      icu_intervals: [],
    } as never);

    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "get-activity-laps",
      arguments: { id: "229781" },
    });

    // The point of #243: a caller chains on fields instead of regexing ids
    // out of prose. That only holds if the SDK actually serialises them.
    expect(result?.structuredContent).toMatchObject({ activity_id: "229781" });
  });

  it("returns a tool error as isError, not a JSON-RPC error", async () => {
    const client = await connectTestClient();
    const { result, error } = await client.send("tools/call", {
      name: "get-activity-laps",
      arguments: { id: "not-an-id" },
    });

    // A tool that rejects its arguments is a normal result the model can read
    // and correct, not a protocol failure.
    expect(error).toBeUndefined();
    expect(result?.isError).toBe(true);
  });

  it("answers an unknown tool without breaking the session", async () => {
    const client = await connectTestClient();

    const unknown = await client.send("tools/call", {
      name: "no-such-tool",
      arguments: {},
    });
    expect(unknown.result?.isError).toBe(true);

    // The session survives it: a bad call must not poison the transport.
    const after = await client.send("tools/list");
    expect((after.result?.tools as unknown[] | undefined)?.length).toBe(
      TOOL_DEFS.length,
    );
  });

  it("keeps a 64-bit id intact end to end", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "9007199254740993",
      name: "Long Run",
      type: "Run",
      distance: 10000,
      moving_time: 3000,
    } as never);

    const client = await connectTestClient();
    await client.send("tools/call", {
      name: "view-activity-chart",
      arguments: { activity_id: "9007199254740993" },
    });

    // 2^53 + 1 survives only because ids travel as strings and the body is
    // parsed with `parseJsonWithLargeInts`; a JSON number would arrive as
    // ...992 with the true digits unrecoverable.
    const [, id] = mockedIntervalsActivity.mock.calls[0]!;
    expect(String(id)).toBe("9007199254740993");
  });
});

/** The one app whose resource carries per-app `_meta.ui` extras (its CSP). */
const ROUTE_MAP_URI = "ui://route-map/app.html";
const TILE_ORIGIN = "https://tiles.openfreemap.org";

describe("resources/list", () => {
  it("lists every MCP App resource with its ui:// uri and a title", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("resources/list");
    const resources = result?.resources as Array<Record<string, unknown>>;

    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(String(resource.uri)).toMatch(/^ui:\/\//);
      expect(resource.mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.title).toEqual(expect.stringMatching(/\S/));
    }
  });

  it("carries the card-chrome _meta each app depends on", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("resources/list");
    const resources = result?.resources as Array<Record<string, unknown>>;

    // `prefersBorder: false` on the descriptor is half of the convention —
    // the apps draw their own card, and a host border would double it.
    for (const resource of resources) {
      const meta = resource._meta as { ui?: Record<string, unknown> };
      expect(meta?.ui, `${String(resource.uri)} has no _meta.ui`).toBeTruthy();
      expect(meta.ui?.prefersBorder).toBe(false);
    }
  });
});

describe("resources/read", () => {
  it("returns the app HTML for a declared resource", async () => {
    const client = await connectTestClient();
    const list = await client.send("resources/list");
    const resources = list.result?.resources as
      | Array<{ uri: string }>
      | undefined;
    const first = resources?.[0];
    expect(first).toBeTruthy();

    const { result, error } = await client.send("resources/read", {
      uri: first!.uri,
    });

    expect(error).toBeUndefined();
    const contents = result?.contents as Array<Record<string, unknown>>;
    expect(contents[0]?.uri).toBe(first!.uri);
    // The single-file build is the whole point: a bundle that fails to
    // resolve at runtime would read as an empty or missing document here.
    expect(String(contents[0]?.text)).toContain("<html");
  });

  it("repeats the _meta on the content response, not only the descriptor", async () => {
    const client = await connectTestClient();
    const list = await client.send("resources/list");
    const resources = list.result?.resources as
      | Array<{ uri: string }>
      | undefined;
    const first = resources?.[0];
    expect(first).toBeTruthy();

    const { result } = await client.send("resources/read", { uri: first!.uri });

    // Hosts read it from the descriptor or from the content they just
    // fetched; the convention is to emit it on both.
    const contents = result?.contents as Array<{
      _meta?: { ui?: Record<string, unknown> };
    }>;
    expect(contents[0]?._meta?.ui?.prefersBorder).toBe(false);
  });

  it("carries route-map's tile-origin CSP on the descriptor and the content", async () => {
    const client = await connectTestClient();

    const list = await client.send("resources/list");
    const resources = list.result?.resources as Array<{
      uri: string;
      _meta?: { ui?: { csp?: { connectDomains?: string[] } } };
    }>;
    const descriptor = resources.find((r) => r.uri === ROUTE_MAP_URI);
    expect(descriptor, `${ROUTE_MAP_URI} is not advertised`).toBeTruthy();

    const { result } = await client.send("resources/read", {
      uri: ROUTE_MAP_URI,
    });
    const contents = result?.contents as Array<{
      _meta?: { ui?: { csp?: { connectDomains?: string[] } } };
    }>;

    // The per-app `ui` extras are the whole reason `appResourceMeta` spreads
    // rather than returning a constant, and a dropped allowlist is invisible
    // by design: the basemap silently falls back to the offline SVG grid with
    // no error anywhere. Both halves of the spread are asserted because hosts
    // read the CSP from either.
    expect(descriptor?._meta?.ui?.csp?.connectDomains).toContain(TILE_ORIGIN);
    expect(contents[0]?._meta?.ui?.csp?.connectDomains).toContain(TILE_ORIGIN);
  });

  it("rejects a uri the server does not serve", async () => {
    const client = await connectTestClient();

    const { error } = await client.send("resources/read", {
      uri: "ui://no-such-app/app.html",
    });

    expect(error).toBeTruthy();
  });
});

describe("prompts", () => {
  it("lists prompts with names, titles and descriptions", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("prompts/list");
    const prompts = result?.prompts as Array<Record<string, unknown>>;

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(typeof prompt.name).toBe("string");
      expect(prompt.title).toEqual(expect.stringMatching(/\S/));
      expect(typeof prompt.description).toBe("string");
    }
  });

  it("renders a prompt's messages through prompts/get", async () => {
    const client = await connectTestClient();
    const list = await client.send("prompts/list");
    const prompts = list.result?.prompts as Array<{ name: string }> | undefined;
    const first = prompts?.[0];
    expect(first).toBeTruthy();

    const { result, error } = await client.send("prompts/get", {
      name: first!.name,
      arguments: {},
    });

    expect(error).toBeUndefined();
    const messages = result?.messages as Array<{
      role: string;
      content: { type: string; text: string };
    }>;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.content.type).toBe("text");
    expect(messages[0]?.content.text.length).toBeGreaterThan(0);
  });
});
