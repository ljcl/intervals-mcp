/**
 * Streaming reader for OpenStreetMap .osm.pbf extracts (Geofabrik, BBBike),
 * enough for the local OpenStreetMap index (osmIndexBuild.ts): nodes, ways
 * and relations with their tags, and the header's replication timestamp.
 * Reads one blob at a time and awaits between blobs, so a long build never
 * holds the event loop for more than one blob. Format:
 * https://wiki.openstreetmap.org/wiki/PBF_Format
 */
import { type FileHandle, open } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { PbfReader } from "pbf";

export type Tags = Record<string, string>;
export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  tags: Tags;
}
export interface OsmWay {
  id: number;
  tags: Tags;
  refs: number[];
}
export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}
export interface OsmRelation {
  id: number;
  tags: Tags;
  members: OsmMember[];
}
/** What a pass wants; a group kind with no callback is skipped undecoded. */
export interface PbfVisitor {
  header?(h: { replication_timestamp: number | null }): void;
  node?(n: OsmNode): void;
  way?(w: OsmWay): void;
  relation?(r: OsmRelation): void;
}

/** The format's own limits: a BlobHeader under 64 KiB, a Blob under 32 MiB. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MEMBER_TYPES = ["node", "way", "relation"] as const;

interface Block {
  strings: string[];
  groups: Array<[number, number]>;
  granularity: number;
  latOffset: number;
  lonOffset: number;
}

export async function readOsmPbf(
  path: string,
  visit: PbfVisitor,
): Promise<void> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let at = 0;
    while (at < size) {
      const length = new DataView(
        (await readExact(file, at, 4)).buffer,
      ).getUint32(0);
      if (length > MAX_HEADER_BYTES) throw new Error("Corrupt .osm.pbf file");
      const header = new PbfReader(
        await readExact(file, at + 4, length),
      ).readFields(
        (tag, h, pbf) => {
          if (tag === 1) h.type = pbf.readString();
          else if (tag === 3) h.datasize = pbf.readVarint();
        },
        { type: "", datasize: 0 },
      );
      if (header.datasize > MAX_BLOB_BYTES)
        throw new Error("Corrupt .osm.pbf file");
      const blob = await readExact(file, at + 4 + length, header.datasize);
      at += 4 + length + header.datasize;
      if (header.type === "OSMHeader") {
        if (visit.header) visit.header(readHeaderBlock(blobData(blob)));
      } else if (header.type === "OSMData") {
        readPrimitiveBlock(blobData(blob), visit);
      }
    }
  } finally {
    await file.close();
  }
}

async function readExact(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Truncated .osm.pbf file");
  return buffer;
}

function blobData(buf: Uint8Array): Uint8Array {
  const blob = new PbfReader(buf).readFields(
    (tag, b, pbf) => {
      if (tag === 1) b.raw = pbf.readBytes();
      else if (tag === 3) b.zlib = pbf.readBytes();
      else if (tag >= 4) b.other = true;
    },
    {
      raw: null as Uint8Array | null,
      zlib: null as Uint8Array | null,
      other: false,
    },
  );
  if (blob.raw) return blob.raw;
  if (blob.zlib) return inflateSync(blob.zlib);
  throw new Error(
    "Unsupported .osm.pbf compression: only zlib and uncompressed blobs are read (Geofabrik and BBBike use zlib)",
  );
}

function readHeaderBlock(buf: Uint8Array): {
  replication_timestamp: number | null;
} {
  return new PbfReader(buf).readFields(
    (tag, h, pbf) => {
      if (tag === 32) h.replication_timestamp = pbf.readVarint(true);
    },
    { replication_timestamp: null as number | null },
  );
}

function readPrimitiveBlock(buf: Uint8Array, visit: PbfVisitor): void {
  const pbf = new PbfReader(buf);
  // Granularity and offsets follow the groups on the wire, so groups are read last.
  const block = pbf.readFields<Block>(
    (tag, b, p) => {
      if (tag === 1)
        b.strings = p.readMessage((t, list: string[], q) => {
          if (t === 1) list.push(q.readString());
        }, []);
      else if (tag === 2) {
        const end = p.readVarint() + p.pos;
        b.groups.push([p.pos, end]);
        p.pos = end;
      } else if (tag === 17) b.granularity = p.readVarint();
      else if (tag === 19) b.latOffset = p.readVarint(true);
      else if (tag === 20) b.lonOffset = p.readVarint(true);
    },
    { strings: [], groups: [], granularity: 100, latOffset: 0, lonOffset: 0 },
  );
  for (const [start, end] of block.groups) {
    pbf.pos = start;
    pbf.readFields(
      (tag, _, p) => {
        if (tag === 1 && visit.node) visit.node(readNode(p, block));
        else if (tag === 2 && visit.node) readDense(p, block, visit.node);
        else if (tag === 3 && visit.way) visit.way(readWay(p, block));
        else if (tag === 4 && visit.relation)
          visit.relation(readRelation(p, block));
      },
      null,
      end,
    );
  }
}

function coordinate(raw: number, offset: number, granularity: number): number {
  return 1e-9 * (offset + granularity * raw);
}

function tagsOf(keys: number[], vals: number[], strings: string[]): Tags {
  const tags: Tags = {};
  keys.forEach((k, i) => {
    tags[strings[k] ?? ""] = strings[vals[i] ?? 0] ?? "";
  });
  return tags;
}

function readNode(p: PbfReader, b: Block): OsmNode {
  const n = p.readMessage(
    (tag, n, q) => {
      if (tag === 1) n.id = q.readSVarint();
      else if (tag === 2) q.readPackedVarint(n.keys);
      else if (tag === 3) q.readPackedVarint(n.vals);
      else if (tag === 8) n.lat = q.readSVarint();
      else if (tag === 9) n.lon = q.readSVarint();
    },
    { id: 0, keys: [] as number[], vals: [] as number[], lat: 0, lon: 0 },
  );
  return {
    id: n.id,
    lat: coordinate(n.lat, b.latOffset, b.granularity),
    lon: coordinate(n.lon, b.lonOffset, b.granularity),
    tags: tagsOf(n.keys, n.vals, b.strings),
  };
}

function readDense(p: PbfReader, b: Block, node: (n: OsmNode) => void): void {
  const d = p.readMessage(
    (tag, d, q) => {
      if (tag === 1) q.readPackedSVarint(d.ids);
      else if (tag === 8) q.readPackedSVarint(d.lats);
      else if (tag === 9) q.readPackedSVarint(d.lons);
      else if (tag === 10) q.readPackedVarint(d.kv);
    },
    {
      ids: [] as number[],
      lats: [] as number[],
      lons: [] as number[],
      kv: [] as number[],
    },
  );
  let id = 0;
  let lat = 0;
  let lon = 0;
  let k = 0;
  for (let i = 0; i < d.ids.length; i++) {
    id += d.ids[i]!;
    lat += d.lats[i]!;
    lon += d.lons[i]!;
    const tags: Tags = {};
    // keys_vals is k,v,...,0 per node, and empty when no node has tags.
    while (k < d.kv.length && d.kv[k] !== 0) {
      tags[b.strings[d.kv[k]!] ?? ""] = b.strings[d.kv[k + 1] ?? 0] ?? "";
      k += 2;
    }
    k++;
    node({
      id,
      lat: coordinate(lat, b.latOffset, b.granularity),
      lon: coordinate(lon, b.lonOffset, b.granularity),
      tags,
    });
  }
}

function readWay(p: PbfReader, b: Block): OsmWay {
  const w = p.readMessage(
    (tag, w, q) => {
      if (tag === 1) w.id = q.readVarint(true);
      else if (tag === 2) q.readPackedVarint(w.keys);
      else if (tag === 3) q.readPackedVarint(w.vals);
      else if (tag === 8) q.readPackedSVarint(w.refs);
    },
    { id: 0, keys: [] as number[], vals: [] as number[], refs: [] as number[] },
  );
  for (let i = 1; i < w.refs.length; i++) w.refs[i]! += w.refs[i - 1]!;
  return { id: w.id, tags: tagsOf(w.keys, w.vals, b.strings), refs: w.refs };
}

function readRelation(p: PbfReader, b: Block): OsmRelation {
  const r = p.readMessage(
    (tag, r, q) => {
      if (tag === 1) r.id = q.readVarint(true);
      else if (tag === 2) q.readPackedVarint(r.keys);
      else if (tag === 3) q.readPackedVarint(r.vals);
      else if (tag === 8) q.readPackedVarint(r.roles);
      else if (tag === 9) q.readPackedSVarint(r.ids);
      else if (tag === 10) q.readPackedVarint(r.types);
    },
    {
      id: 0,
      keys: [] as number[],
      vals: [] as number[],
      roles: [] as number[],
      ids: [] as number[],
      types: [] as number[],
    },
  );
  let ref = 0;
  return {
    id: r.id,
    tags: tagsOf(r.keys, r.vals, b.strings),
    members: r.ids.map((delta, i) => {
      ref += delta;
      return {
        type: MEMBER_TYPES[r.types[i] ?? 0] ?? "node",
        ref,
        role: b.strings[r.roles[i] ?? 0] ?? "",
      };
    }),
  };
}
