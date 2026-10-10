/**
 * The MCP protocol surface, asserted through the real server (ljcl/strava-mcp#270).
 *
 * Every other server suite enters below the protocol layer — calling
 * `dispatchToolCall` directly, or building a throwaway `new Server()` with no
 * tools on it. That leaves the wiring between transport and handlers
 * unverified: a dropped `setRequestHandler`, an input schema that serialises
 * to something a host cannot generate against, or a broken app-resource
 * template would all ship green.
 *
 * So these drive real requests through the endpoint and assert the JSON that comes back. The
 * suite is deliberately the last piece of epic ljcl/strava-mcp#284, so it asserts the
 * finished surface — the output schemas and the progress plumbing — rather
 * than being amended three times on the way.
 */
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTimeZone, setAthleteTimeZone } from "./config";
import { serverInstructions } from "./instructions";
import {
  getActivity,
  getActivityStreams,
  getAthletePaceCurves,
  listActivities,
  searchActivities,
  updateActivity,
} from "./intervalsClient";
import { INTERVALS_ID_HINT, INTERVALS_ID_HINT_LATEST } from "./tools/_ids";

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getAthletePaceCurves: vi.fn(),
    // get-activity fires this next to getActivity. Without a mock it would
    // send a live request through the real intervalsApi. An implementation
    // passed to vi.fn survives vi.clearAllMocks below.
    getSportSettings: vi.fn(async () => null),
    listActivities: vi.fn(),
    searchActivities: vi.fn(),
    // Never reached: the 2025-era write guard refuses update-activity first.
    updateActivity: vi.fn(),
  };
});

// Dispatch resolves the key before any handler runs (ljcl/strava-mcp#240), so without this
// an end-to-end tools/call reads process.env directly.
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { connectTestClient } = await import("./mcpTestClient");
const { TOOL_DEFS } = await import("./server");

const mockedIntervalsActivity = vi.mocked(getActivity);
const mockedIntervalsStreams = vi.mocked(getActivityStreams);
const mockedAthleteCurves = vi.mocked(getAthletePaceCurves);

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

/**
 * The instructions name the configured zone, so their length varies with it.
 * This 32-character IANA link is the longest name `TZ` accepts;
 * `Intl.supportedValuesOf("timeZone")` lists canonical zones only, so its
 * longest would pass a text that overflows here (#147).
 */
const LONGEST_TIME_ZONE = "America/Argentina/ComodRivadavia";

/** A tool name as a description mentions one, e.g. "use get-fitness-trend". */
const TOOL_NAME_MENTION =
  /\b(?:get|list|view|compare|update)-[a-z]+(?:-[a-z]+)*\b/g;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listActivities).mockReset();
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
      completions: expect.any(Object),
    });
    // Deprecated in this revision (SEP-2577), so not advertised (#72).
    expect(discover.capabilities).not.toHaveProperty("logging");
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

  it("keeps the instructions within budget for the longest time zone name", () => {
    expect(serverInstructions(LONGEST_TIME_ZONE).length).toBeLessThanOrEqual(
      MAX_INSTRUCTIONS_CHARS,
    );
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
 * surface uses: `id`, `activityId1`, `activityId2`, and any `*_id`. The
 * narrower `/(^|_)(id|Id)$/` this replaced skipped the camelCase and
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
    // left stuck on "expected string, received number" (ljcl/strava-mcp#282). A hand-rolled
    // `z.string().regex(/^\d+$/)` serialises to the same shape while
    // rejecting that call, so the hint appended to every id's description is
    // what distinguishes it here: `intervalsActivityIdInput`'s own hint,
    // matched at the end of the description so a copy of it would not
    // accidentally pass.
    for (const { tool, field, prop } of ids) {
      if (NON_NUMERIC_ID_FIELDS.has(field)) continue;
      const description = prop.description ?? "";
      // update-activity alone refuses "latest" (a write must name its target).
      const noLatest = tool === "update-activity" && field === "id";
      expect(
        description.endsWith(
          noLatest ? INTERVALS_ID_HINT : INTERVALS_ID_HINT_LATEST,
        ),
        `${tool}.${field} must use intervalsActivityIdInput`,
      ).toBe(true);
      expect(prop.pattern, `${tool}.${field} pattern`).toBe(
        noLatest ? "^i?\\d+$" : "^(?:i?\\d+|latest)$",
      );
    }
  });
});

describe("tools/call", () => {
  it("searches activities over the wire", async () => {
    vi.mocked(searchActivities).mockResolvedValueOnce([
      {
        id: "i700",
        name: "Club 10K",
        type: "Run",
        start_date_local: "2024-09-26T07:00:00",
      },
    ] as never);
    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "list-activities",
      arguments: { search: "club 10k" },
    });
    expect(result?.structuredContent).toMatchObject({
      search: "club 10k",
      activities: [{ id: "i700", race: false, tags: [] }],
    });
  });

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

    // The point of ljcl/strava-mcp#243: a caller chains on fields instead of regexing ids
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
    mockedIntervalsStreams.mockResolvedValueOnce([
      { type: "time", data: [0, 1, 2] },
    ]);

    const client = await connectTestClient();
    await client.send("tools/call", {
      name: "view-activity-chart",
      arguments: { id: "9007199254740993" },
    });

    // 2^53 + 1 survives only because ids travel as strings and the body is
    // parsed with `parseJsonWithLargeInts`; a JSON number would arrive as
    // ...992 with the true digits unrecoverable.
    const [, id] = mockedIntervalsActivity.mock.calls[0]!;
    expect(String(id)).toBe("9007199254740993");
  });
});

describe("tools/call on a view-* tool", () => {
  const MCP_APPS_CAPABILITIES = {
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  };

  // Every read answers, so get-activity-zones, which a host without MCP Apps
  // gets in the same call, reads the activity too.
  afterEach(() => {
    mockedIntervalsActivity.mockReset();
  });

  function mockZonesActivity() {
    mockedIntervalsActivity.mockResolvedValue({
      id: "123",
      name: "Morning Run",
      type: "Run",
      start_date_local: "2026-06-01T07:00:00",
      icu_hr_zones: [130, 155, 190],
      icu_hr_zone_times: [600, 1800, 600],
    } as never);
  }

  async function viewText(clientCapabilities?: unknown): Promise<string> {
    mockZonesActivity();
    const client = await connectTestClient();
    const { result, error } = await client.send("tools/call", {
      name: "view-activity-zones",
      arguments: { id: "123" },
      ...(clientCapabilities === undefined
        ? {}
        : { _meta: { [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities } }),
    });
    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    const content = result?.content as Array<{ type: string; text: string }>;
    return content[0]?.text ?? "";
  }

  it("claims a rendered chart when the request advertises MCP Apps", async () => {
    const text = await viewText(MCP_APPS_CAPABILITIES);

    expect(
      text.endsWith("[Interactive zone distribution chart rendered above]"),
    ).toBe(true);
    expect(text).not.toContain("This client cannot display");
  });

  it("gives get-activity-zones' text when the request advertises no capabilities", async () => {
    const text = await viewText();

    expect(text).not.toContain("rendered above");
    expect(
      text.startsWith(
        "This client cannot display the interactive zone distribution chart. The same data from get-activity-zones follows.\n\n",
      ),
    ).toBe(true);
    expect(text).toContain("Z2 (131-155 bpm): 30:00 (60%)");
  });

  it("names the text twin when the extension lacks the MCP App mime type", async () => {
    const text = await viewText({
      extensions: {
        "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
      },
    });

    expect(text).not.toContain("rendered above");
    expect(text).toContain("The same data from get-activity-zones follows.");
  });
});

describe("2025-era requests (claude.ai's MCP Apps loader)", () => {
  // claude.ai loads an app's ui:// resource and its data tool with a
  // 2025-11-25 client. The endpoint serves it statelessly, but that path
  // skips the Mcp-Method/Mcp-Name check, so it lists and runs no write.
  afterEach(() => {
    mockedIntervalsActivity.mockReset();
  });

  it("answers initialize, reads an app resource and runs its data tool", async () => {
    mockedIntervalsActivity.mockResolvedValue({
      id: "123",
      name: "Morning Run",
      type: "Run",
      start_date_local: "2026-06-01T07:00:00",
      icu_hr_zones: [130, 155, 190],
      icu_hr_zone_times: [600, 1800, 600],
    } as never);
    const client = await connectTestClient();

    const init = await client.sendLegacy("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "0.1.0" },
    });
    const read = await client.sendLegacy("resources/read", {
      uri: "ui://activity-zones/app.html",
    });
    const call = await client.sendLegacy("tools/call", {
      name: "get-activity-zones-data",
      arguments: { id: "123" },
    });

    expect(init.error).toBeUndefined();
    expect(init.result?.protocolVersion).toBe("2025-11-25");
    const [content] = (read.result?.contents ?? []) as Array<
      Record<string, unknown>
    >;
    expect(content?.mimeType).toBe("text/html;profile=mcp-app");
    expect(content?._meta).toEqual({ ui: { prefersBorder: false } });
    expect(String(content?.text)).toContain("<html");
    expect(call.result?.isError).toBeUndefined();
    const [block] = (call.result?.content ?? []) as Array<{ text: string }>;
    expect(JSON.parse(block?.text ?? "").zoneSets).toHaveLength(1);
  });

  it("lists every tool but update-activity", async () => {
    const client = await connectTestClient();

    const legacy = await client.sendLegacy("tools/list");
    const modern = await client.send("tools/list");

    const names = (result: Record<string, unknown> | undefined) =>
      ((result?.tools ?? []) as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
    expect(names(modern.result)).toContain("update-activity");
    expect(names(legacy.result)).toEqual(
      names(modern.result).filter((name) => name !== "update-activity"),
    );
  });

  it("refuses update-activity, even past a spoofed Mcp-Name", async () => {
    const client = await connectTestClient();

    const { result, error } = await client.sendLegacy(
      "tools/call",
      { name: "update-activity", arguments: { id: "123", name: "x" } },
      { "Mcp-Method": "tools/call", "Mcp-Name": "get-wellness" },
    );

    expect(error).toBeUndefined();
    expect(result?.isError).toBe(true);
    const [block] = (result?.content ?? []) as Array<{ text: string }>;
    expect(block?.text).toBe(
      "❌ update-activity changes data, and this client connects with a 2025 protocol revision, so the server does not run it. To make the change, use a client that speaks the 2026-07-28 revision.",
    );
    // Refused before the handler's fresh read of the activity.
    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
    expect(vi.mocked(updateActivity)).not.toHaveBeenCalled();
  });
});

describe("tools/list input naming scheme (#141)", () => {
  it("advertises id, activityId1/activityId2 and days on the app tools", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("tools/list");
    const tools = result?.tools as Array<{
      name: string;
      inputSchema: { properties?: Record<string, Record<string, unknown>> };
    }>;
    const keys = (name: string) =>
      Object.keys(
        tools.find((t) => t.name === name)?.inputSchema.properties ?? {},
      );

    expect(keys("view-route-map")).toEqual(["id", "waypoints"]);
    expect(keys("get-activity-streams-raw")).toEqual(["id"]);
    expect(keys("view-compare-activities")).toEqual([
      "activityId1",
      "activityId2",
    ]);
    const days = tools.find((t) => t.name === "view-cadence-trends")
      ?.inputSchema.properties?.days;
    expect(days).toMatchObject({
      type: "integer",
      minimum: 7,
      maximum: 728,
      default: 42,
    });
  });
});

describe("tools/call forgiving arguments (#78)", () => {
  const callText = (result: Record<string, unknown> | undefined) =>
    (result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "";

  it("accepts activity_id, the app tools' old spelling of id", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "229781",
      name: "Hawk Hill",
      type: "Run",
    } as never);

    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "view-route-map",
      arguments: { activity_id: "229781" },
    });

    expect(callText(result)).not.toContain("Invalid arguments");
    expect(mockedIntervalsActivity.mock.calls[0]?.[1]).toBe("229781");
  });

  it('accepts "Half Marathon" where get-best-efforts spells it "half marathon"', async () => {
    mockedAthleteCurves.mockResolvedValue({
      list: [],
      activities: {},
    } as never);

    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "get-best-efforts",
      arguments: { distances: ["Half Marathon", "5K"] },
    });

    expect(callText(result)).not.toContain("Invalid arguments");
    expect(mockedAthleteCurves).toHaveBeenCalled();
  });

  it("reads get-best-efforts oldest/newest as its window (#151)", async () => {
    mockedAthleteCurves.mockResolvedValue({
      list: [],
      activities: {},
    } as never);

    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "get-best-efforts",
      arguments: { oldest: "2026-01-01", newest: "2026-03-31" },
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({
      window: { oldest: "2026-01-01", newest: "2026-03-31" },
    });
    expect(JSON.stringify(result?.content)).not.toContain("Ignored");
  });

  it("says which keys a successful call ignored (#151)", async () => {
    mockedAthleteCurves.mockResolvedValue({
      list: [],
      activities: {},
    } as never);

    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "get-best-efforts",
      arguments: { distances: ["5km"], sport: "Run" },
    });

    expect(result?.isError).toBeFalsy();
    const content = result?.content as Array<{ type: string; text: string }>;
    expect(content.at(-1)).toEqual({
      type: "text",
      text: 'Ignored argument "sport" (this tool takes: id, distances, window, topN).',
    });
  });

  it("names the unknown key and the expected ones when a call still fails", async () => {
    const client = await connectTestClient();
    const { result, error } = await client.send("tools/call", {
      name: "get-activity",
      arguments: { activity: "229781" },
    });

    expect(error).toBeUndefined();
    expect(result?.isError).toBe(true);
    const text = callText(result);
    expect(text).toMatch(/^❌ Invalid arguments for get-activity: /);
    expect(text).toContain(
      'Unknown argument "activity" (this tool takes: id, includeIntervals).',
    );
    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
  });
});

describe("tools/call id latest", () => {
  it('resolves id "latest" to the newest run before the handler runs', async () => {
    vi.mocked(listActivities).mockResolvedValueOnce([
      { id: "i555", type: "Run", start_date_local: "2026-10-01T07:00:00" },
    ] as never);
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "i555",
      name: "Easy",
      type: "Run",
      start_date_local: "2026-10-01T07:00:00",
    } as never);
    const client = await connectTestClient();
    await client.send("tools/call", {
      name: "get-activity",
      arguments: { id: "latest" },
    });
    expect(mockedIntervalsActivity.mock.calls[0]?.[1]).toBe("i555");
  });

  it('resolves id "latest" for an app data feed', async () => {
    vi.mocked(listActivities).mockResolvedValueOnce([
      { id: "i556", type: "Run", start_date_local: "2026-10-01T07:00:00" },
    ] as never);
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "i556",
      name: "Hawk Hill",
      type: "Run",
    } as never);
    const client = await connectTestClient();
    await client.send("tools/call", {
      name: "get-route-map-data",
      arguments: { id: "latest" },
    });
    expect(mockedIntervalsActivity.mock.calls[0]?.[1]).toBe("i556");
  });

  it("resolves both compare ids from one lookup", async () => {
    vi.mocked(listActivities).mockResolvedValueOnce([
      { id: "i557", type: "Run", start_date_local: "2026-10-01T07:00:00" },
    ] as never);
    mockedIntervalsActivity.mockResolvedValue({
      id: "i557",
      name: "Easy",
      type: "Run",
      start_date_local: "2026-10-01T07:00:00",
    } as never);
    const client = await connectTestClient();
    await client.send("tools/call", {
      name: "compare-activities",
      arguments: { activityId1: "latest", activityId2: "latest" },
    });
    expect(vi.mocked(listActivities)).toHaveBeenCalledTimes(1);
    const ids = mockedIntervalsActivity.mock.calls.map((call) => call[1]);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids)).toEqual(new Set(["i557"]));
  });

  it("reports the resolved id in _meta, for view-route-map", async () => {
    vi.mocked(listActivities).mockResolvedValueOnce([
      { id: "i558", type: "Run", start_date_local: "2026-10-01T07:00:00" },
    ] as never);
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "i558",
      name: "Hawk Hill",
      type: "Run",
    } as never);
    mockedIntervalsStreams.mockResolvedValueOnce([]);
    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "view-route-map",
      arguments: { id: "latest" },
    });
    expect(result?._meta).toMatchObject({
      "intervals-mcp/resolvedArgs": { id: "i558" },
    });
  });

  it("reports both resolved ids in _meta, for view-compare-activities", async () => {
    vi.mocked(listActivities).mockResolvedValueOnce([
      { id: "i559", type: "Run", start_date_local: "2026-10-01T07:00:00" },
    ] as never);
    mockedIntervalsActivity.mockResolvedValue({
      id: "i559",
      name: "Easy",
      type: "Run",
      start_date_local: "2026-10-01T07:00:00",
    } as never);
    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "view-compare-activities",
      arguments: { activityId1: "latest", activityId2: "latest" },
    });
    expect(result?._meta).toMatchObject({
      "intervals-mcp/resolvedArgs": {
        activityId1: "i559",
        activityId2: "i559",
      },
    });
  });

  it("has no resolvedArgs when no id was latest", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "229781",
      name: "Hawk Hill",
      type: "Run",
    } as never);
    mockedIntervalsStreams.mockResolvedValueOnce([]);
    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "view-route-map",
      arguments: { id: "229781" },
    });
    expect(result?._meta ?? {}).not.toHaveProperty(
      "intervals-mcp/resolvedArgs",
    );
  });

  it('says so when there is no run to use for "latest"', async () => {
    vi.mocked(listActivities).mockResolvedValue([]);
    const client = await connectTestClient();
    const { result } = await client.send("tools/call", {
      name: "get-activity",
      arguments: { id: "latest" },
    });
    expect(result?.isError).toBe(true);
    expect(
      (result?.content as Array<{ text: string }> | undefined)?.[0]?.text,
    ).toBe(
      '❌ No run in the last 366 days to use for "latest"; pass an id from list-activities.',
    );
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

  it("lists the race-readiness, run-debrief and injury-check workflows with titles", async () => {
    const client = await connectTestClient();
    const { result } = await client.send("prompts/list");
    const prompts = result?.prompts as Array<{ name: string; title: string }>;

    for (const name of ["race-readiness", "run-debrief", "injury-check"]) {
      const prompt = prompts.find((p) => p.name === name);
      expect(prompt?.title, name).toMatch(/\S/);
    }
  });

  it("reviews 12 weeks of activities for weeks: 12", async () => {
    const client = await connectTestClient();
    const { result, error } = await client.send("prompts/get", {
      name: "weekly-review",
      arguments: { weeks: "12" },
    });

    expect(error).toBeUndefined();
    const messages = result?.messages as Array<{ content: { text: string } }>;
    const text = messages[0]?.content.text ?? "";
    expect(text).toContain("get-training-load with days=84");
    expect(text).toMatch(
      /list-activities with oldest=\d{4}-\d{2}-\d{2}, newest=\d{4}-\d{2}-\d{2}/,
    );
  });

  it("rejects weeks: 100 with Invalid Params (-32602)", async () => {
    const client = await connectTestClient();
    const { result, error } = await client.send("prompts/get", {
      name: "weekly-review",
      arguments: { weeks: "100" },
    });

    expect(result).toBeUndefined();
    expect(error?.code).toBe(-32602);
    expect(error?.message).toContain(
      "weeks must be a whole number from 1 to 52",
    );
  });

  it("completes a prompt argument through completion/complete", async () => {
    const client = await connectTestClient();
    const { result, error } = await client.send("completion/complete", {
      ref: { type: "ref/prompt", name: "race-readiness" },
      argument: { name: "distance", value: "ha" },
    });

    expect(error).toBeUndefined();
    expect(result?.completion).toMatchObject({ values: ["half marathon"] });
  });

  it("completes nothing for a resource template reference", async () => {
    const client = await connectTestClient();
    const { result, error } = await client.send("completion/complete", {
      ref: { type: "ref/resource", uri: "ui://route-map/app.html" },
      argument: { name: "x", value: "" },
    });

    expect(error).toBeUndefined();
    expect(result?.completion).toMatchObject({ values: [] });
  });

  it("answers an unknown prompt with Invalid Params (-32602), not Internal Error", async () => {
    const client = await connectTestClient();

    const { result, error } = await client.send("prompts/get", {
      name: "no-such-prompt",
      arguments: {},
    });

    // The same code resources/read gives an unknown uri: the request was
    // wrong, not the server.
    expect(result).toBeUndefined();
    expect(error?.code).toBe(-32602);
    expect(error?.message).toBe("Unknown prompt: no-such-prompt");
  });
});

/**
 * The athlete's intervals.icu zone (#56) reaches what a host receives: the
 * instructions in server/discover and the "today" behind id "latest". TZ=UTC
 * is compose's default, which means "follow the athlete".
 */
describe("athlete time zone over the wire", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "UTC";
    setAthleteTimeZone("Australia/Sydney");
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    setAthleteTimeZone(null);
    vi.useRealTimers();
  });

  it("names the athlete's zone in the server/discover instructions", async () => {
    const { discover } = await connectTestClient("athlete-zone-discover");
    expect(discover.instructions).toContain("Australia/Sydney");
  });

  /** The newest date of the first window id "latest" lists, at 21:30 UTC. */
  async function latestWindowNewest(): Promise<string | undefined> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T21:30:00Z"));
    vi.mocked(listActivities).mockResolvedValueOnce([
      { id: "i560", type: "Run", start_date_local: "2026-10-05T07:00:00" },
    ] as never);
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "i560",
      name: "Easy",
      type: "Run",
    } as never);
    const client = await connectTestClient();
    await client.send("tools/call", {
      name: "get-activity",
      arguments: { id: "latest" },
    });
    return vi.mocked(listActivities).mock.calls[0]?.[1]?.newest;
  }

  it('dates "latest" by the athlete\'s zone: already the 5th in Sydney', async () => {
    expect(await latestWindowNewest()).toBe("2026-10-05");
  });

  it('dates "latest" by UTC when the athlete has no zone', async () => {
    setAthleteTimeZone(null);
    expect(await latestWindowNewest()).toBe("2026-10-04");
  });

  it("keeps the instructions within budget for the longest athlete zone", async () => {
    setAthleteTimeZone(LONGEST_TIME_ZONE);
    const { discover } = await connectTestClient("athlete-zone-budget");
    const text = discover.instructions as string;
    expect(text).toContain(LONGEST_TIME_ZONE);
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
  });
});
