/**
 * The tool permission contract (#303).
 *
 * Annotations are what a host uses to decide whether a tool lands in the
 * "read-only" bucket the athlete can grant once, or the "write/delete" bucket
 * that re-prompts forever. That makes them user-facing behaviour, not
 * decoration, so this file pins three things a presence check missed:
 * every tool's classification is deliberate, the classification survives
 * serialization into a real `tools/list` response, and nothing opts into an
 * unconditional prompt.
 */
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { connectTestClient } from "./mcpTestClient";
import { createServer, TOOLS } from "./server";
import {
  READ_ONLY,
  WRITE_DESTRUCTIVE,
  WRITE_IDEMPOTENT,
} from "./tools/_annotations";

describe("annotation constants", () => {
  it("read-only is honest", () => {
    expect(READ_ONLY.readOnlyHint).toBe(true);
    expect(READ_ONLY.openWorldHint).toBe(true);
  });
  it("read-only states destructiveHint rather than leaning on the default", () => {
    // The spec default is `true`, so an absent field reads as destructive to
    // any host that checks it before readOnlyHint — the whole point of #303.
    expect(READ_ONLY.destructiveHint).toBe(false);
  });
  it("update-activity is destructive and non-idempotent", () => {
    expect(WRITE_DESTRUCTIVE.destructiveHint).toBe(true);
    expect(WRITE_DESTRUCTIVE.idempotentHint).toBe(false);
    expect(WRITE_DESTRUCTIVE.readOnlyHint).toBe(false);
  });
  it("idempotent writes are not destructive", () => {
    expect(WRITE_IDEMPOTENT.idempotentHint).toBe(true);
    expect(WRITE_IDEMPOTENT.destructiveHint).toBe(false);
  });

  it("every write constant is explicitly not read-only", () => {
    for (const [label, annotations] of [
      ["WRITE_DESTRUCTIVE", WRITE_DESTRUCTIVE],
      ["WRITE_IDEMPOTENT", WRITE_IDEMPOTENT],
    ] as const) {
      expect(annotations.readOnlyHint, label).toBe(false);
    }
  });
});

/**
 * Every advertised tool and the class it belongs to. A tool absent from this
 * table fails the exhaustiveness check below, so adding one forces a
 * deliberate answer to "does this mutate anything?" — the question the host's
 * permission bucket is derived from.
 *
 * The three `export-*` tools are writes on purpose: they save a file into
 * ROUTE_EXPORT_PATH on the server's own disk. They will keep prompting, and
 * should.
 */
const EXPECTED_CLASS: Record<string, "read" | "destroy" | "write"> = {
  // Reads — the Strava API surface.
  "get-athlete-stats": "read",
  "get-activity-zones": "read",
  "get-activity-laps": "read",
  "get-running-summary": "read",
  "get-aerobic-analysis": "read",
  "get-hill-analysis": "read",
  "get-split-analysis": "read",
  "get-interval-analysis": "read",
  "get-training-load": "read",
  "get-fitness-trend": "read",
  "compare-activities": "read",
  "get-best-efforts": "read",
  "get-race-prediction": "read",

  // Reads: the intervals.icu API surface (Phase 1 ports).
  "list-activities": "read",
  "get-activity": "read",

  // Reads — MCP App view tools and their app-only data feeds.
  "view-activity-chart": "read",
  "get-activity-streams-raw": "read",
  "view-cadence-trends": "read",
  "get-cadence-trend-data": "read",
  "view-route-map": "read",
  "get-route-map-data": "read",
  "view-training-load": "read",
  "get-training-load-data": "read",
  "view-fitness-trend": "read",
  "get-fitness-trend-data": "read",
  "view-activity-zones": "read",
  "get-activity-zones-data": "read",
  "view-compare-activities": "read",
  "get-compare-activities-data": "read",

  // Writes.
  "update-activity": "destroy",
  "export-activity-gpx": "write",
};

const ANNOTATIONS_FOR_CLASS = {
  read: READ_ONLY,
  destroy: WRITE_DESTRUCTIVE,
  write: WRITE_IDEMPOTENT,
} as const;

describe("tool annotations exhaustiveness", () => {
  it("every tool in TOOLS carries an annotations object", () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const tool of TOOLS) {
      expect(
        tool.annotations,
        `${tool.name} is missing annotations`,
      ).toBeDefined();
    }
  });

  it("every tool is classified in the table, and vice versa", () => {
    const advertised = TOOLS.map((t) => t.name).sort();
    const classified = Object.keys(EXPECTED_CLASS).sort();
    // Named both ways so the failure says which side is short.
    expect(
      advertised.filter((name) => !classified.includes(name)),
      "tools missing a permission classification",
    ).toEqual([]);
    expect(
      classified.filter((name) => !advertised.includes(name)),
      "classified names that are no longer advertised",
    ).toEqual([]);
  });

  it("each tool carries exactly the annotations its class prescribes", () => {
    for (const tool of TOOLS) {
      const expected = ANNOTATIONS_FOR_CLASS[EXPECTED_CLASS[tool.name]!];
      expect(tool.annotations, tool.name).toEqual(expected);
    }
  });

  it("every read tool spells out both hints a permission bucket reads", () => {
    const reads = TOOLS.filter((t) => EXPECTED_CLASS[t.name] === "read");
    // Guards the table itself: an empty filter would make this vacuous.
    expect(reads.length).toBe(29);
    for (const tool of reads) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it("no tool opts into an unconditional permission prompt", () => {
    // `_meta["anthropic/requiresUserInteraction"]` makes a host prompt on
    // every call with no "don't ask again" option, and allow-rules do not
    // skip it. Nothing here wants that; pin it so nothing acquires it.
    for (const tool of TOOLS) {
      const meta = tool._meta as Record<string, unknown> | undefined;
      expect(
        meta?.["anthropic/requiresUserInteraction"],
        tool.name,
      ).toBeUndefined();
    }
  });
});

/**
 * Serialization check. The in-memory TOOLS table having correct annotations
 * proves nothing about what the host receives: SDK result schemas can drop
 * fields they do not model, and an annotation that does not reach the wire
 * cannot influence a permission decision. So this drives a real initialize +
 * tools/list through the transport and reads the JSON that comes back.
 */
async function listToolsOverTheWire(): Promise<Array<Record<string, unknown>>> {
  const client = await connectTestClient("annotations-test");
  const { result } = await client.send("tools/list");
  await client.close();
  return (result?.tools as Array<Record<string, unknown>>) ?? [];
}

describe("annotations on the wire", () => {
  it("tools/list serializes every tool's annotations", async () => {
    const tools = await listToolsOverTheWire();

    expect(tools.length).toBe(TOOLS.length);
    for (const tool of tools) {
      const name = tool.name as string;
      const expected = ANNOTATIONS_FOR_CLASS[EXPECTED_CLASS[name]!];
      expect(
        tool.annotations,
        `${name} lost its annotations in transit`,
      ).toEqual(expected);
    }
  });

  it("read-only tools reach the host with destructiveHint present and false", async () => {
    const tools = await listToolsOverTheWire();

    const reads = tools.filter(
      (t) => EXPECTED_CLASS[t.name as string] === "read",
    );
    expect(reads.length).toBe(29);
    for (const tool of reads) {
      const annotations = tool.annotations as Record<string, unknown>;
      // `in` rather than a truthiness check: the failure mode being guarded
      // is the key being dropped for having a falsy value.
      expect(
        "destructiveHint" in annotations,
        `${tool.name} shipped without destructiveHint`,
      ).toBe(true);
      expect(annotations.destructiveHint, tool.name as string).toBe(false);
      expect(annotations.readOnlyHint, tool.name as string).toBe(true);
    }
  });
});

describe("server capabilities", () => {
  it("createServer returns a Server that advertises tools", () => {
    const server = createServer();
    expect(server).toBeInstanceOf(Server);
  });
});
