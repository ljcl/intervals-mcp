import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PbfWriter } from "pbf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FixtureExtract, osmPbfBytes } from "./__fixtures__/osmPbf";
import {
  type HeaderInfo,
  type OsmNode,
  type OsmRelation,
  type OsmWay,
  readOsmPbf,
} from "./osmPbf";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "osm-pbf-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileOf(bytes: Uint8Array): Promise<string> {
  const path = join(dir, "x.osm.pbf");
  await writeFile(path, bytes);
  return path;
}

const EXTRACT: FixtureExtract = {
  replicationTimestamp: 1_794_000_000,
  nodes: [
    { id: 10, lat: -33.87, lon: 151.2 },
    {
      id: 11,
      lat: -33.8712345,
      lon: 151.2012345,
      tags: { highway: "crossing" },
    },
    { id: 9_000_000_123, lat: -33.9, lon: 151.25 },
  ],
  plainNodes: [
    {
      id: 9_000_000_200,
      lat: -33.91,
      lon: 151.26,
      tags: { highway: "traffic_signals" },
    },
  ],
  ways: [
    {
      id: 100,
      refs: [10, 11, 9_000_000_123],
      tags: { highway: "footway", name: "Bay Run" },
    },
    { id: 101, refs: [11, 10] },
  ],
  relations: [
    {
      id: 500,
      tags: { type: "multipolygon", leisure: "park" },
      members: [
        { type: "way", ref: 101, role: "outer" },
        { type: "node", ref: 10, role: "" },
      ],
    },
  ],
};

async function readAll(bytes: Uint8Array) {
  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  let timestamp: number | null | undefined;
  let bbox: HeaderInfo["bbox"] | undefined;
  await readOsmPbf(await fileOf(bytes), {
    header: (h) => {
      timestamp = h.replication_timestamp;
      bbox = h.bbox;
    },
    node: (n) => nodes.push(n),
    way: (w) => ways.push(w),
    relation: (r) => relations.push(r),
  });
  return { nodes, ways, relations, timestamp, bbox };
}

describe("readOsmPbf", () => {
  it.each(["zlib", "raw"] as const)(
    "reads nodes, ways, relations and the header from %s blobs",
    async (compression) => {
      const got = await readAll(osmPbfBytes({ ...EXTRACT, compression }));
      expect(got.timestamp).toBe(1_794_000_000);
      expect(got.nodes.map((n) => n.id)).toEqual([
        10, 11, 9_000_000_123, 9_000_000_200,
      ]);
      expect(got.nodes[1]!.lat).toBeCloseTo(-33.8712345, 7);
      expect(got.nodes[1]!.lon).toBeCloseTo(151.2012345, 7);
      expect(got.nodes[1]!.tags).toEqual({ highway: "crossing" });
      expect(got.nodes[0]!.tags).toEqual({});
      expect(got.nodes[3]!.tags).toEqual({ highway: "traffic_signals" });
      expect(got.nodes[3]!.lat).toBeCloseTo(-33.91, 7);
      expect(got.ways).toEqual([
        {
          id: 100,
          refs: [10, 11, 9_000_000_123],
          tags: { highway: "footway", name: "Bay Run" },
        },
        { id: 101, refs: [11, 10], tags: {} },
      ]);
      expect(got.relations).toEqual([
        {
          id: 500,
          tags: { type: "multipolygon", leisure: "park" },
          members: [
            { type: "way", ref: 101, role: "outer" },
            { type: "node", ref: 10, role: "" },
          ],
        },
      ]);
    },
  );

  it("reads ways with no node visitor", async () => {
    const ways: OsmWay[] = [];
    await readOsmPbf(await fileOf(osmPbfBytes(EXTRACT)), {
      way: (w) => ways.push(w),
    });
    expect(ways.map((w) => w.id)).toEqual([100, 101]);
  });

  it("refuses a compression it cannot read", async () => {
    await expect(
      readAll(osmPbfBytes({ ...EXTRACT, compression: "lzma" })),
    ).rejects.toThrow(/Unsupported \.osm\.pbf compression/);
  });

  it("refuses a truncated file", async () => {
    const bytes = osmPbfBytes(EXTRACT);
    await expect(readAll(bytes.subarray(0, bytes.length - 5))).rejects.toThrow(
      /Truncated \.osm\.pbf file/,
    );
  });

  it("refuses an absurd blob header length", async () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 1 << 20);
    await expect(readAll(bytes)).rejects.toThrow(/Corrupt \.osm\.pbf file/);
  });

  it("refuses a blob header claiming more than 32 MiB", async () => {
    await expect(rawBlock(blobHeader(33 * 1024 * 1024))).rejects.toThrow(
      /Corrupt \.osm\.pbf file/,
    );
  });

  it("refuses a zlib blob that inflates past 32 MiB", async () => {
    const blob = new PbfWriter();
    blob.writeBytesField(3, deflateSync(Buffer.alloc(33 * 1024 * 1024)));
    const body = blob.finish();
    await expect(rawBlock(blobHeader(body.length), body)).rejects.toThrow(
      /Corrupt \.osm\.pbf file/,
    );
  });

  it("reads the header's bounding box, or null without one", async () => {
    const bbox = { south: -34.1, west: 150.9, north: -33.6, east: 151.4 };
    let got: unknown;
    await readOsmPbf(await fileOf(osmPbfBytes({ ...EXTRACT, bbox })), {
      header: (h) => {
        got = h.bbox;
      },
    });
    expect(got).toEqual({
      south: expect.closeTo(-34.1, 9),
      west: expect.closeTo(150.9, 9),
      north: expect.closeTo(-33.6, 9),
      east: expect.closeTo(151.4, 9),
    });
    expect((await readAll(osmPbfBytes(EXTRACT))).bbox).toBeNull();
  });
});

function blobHeader(datasize: number): Uint8Array {
  const head = new PbfWriter();
  head.writeStringField(1, "OSMData");
  head.writeVarintField(3, datasize);
  const bytes = head.finish();
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

async function rawBlock(
  header: Uint8Array,
  body: Uint8Array = new Uint8Array(0),
) {
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return readAll(bytes);
}
