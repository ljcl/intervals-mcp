/**
 * Writes small .osm.pbf files for the OpenStreetMap index tests: a header
 * blob, then one data blob each for nodes, ways and relations, granularity
 * 100 and no offsets (so a raw coordinate is 1e-7 degrees). Format:
 * https://wiki.openstreetmap.org/wiki/PBF_Format
 */
import { deflateSync } from "node:zlib";
import { PbfWriter } from "pbf";
import { type Tags } from "../osmPbf";

export interface FixtureNode {
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}
export interface FixtureWay {
  id: number;
  refs: number[];
  tags?: Tags;
}
export interface FixtureRelation {
  id: number;
  tags?: Tags;
  members: Array<{
    type: "node" | "way" | "relation";
    ref: number;
    role: string;
  }>;
}
export interface FixtureExtract {
  /** Written as DenseNodes, in this order. */
  nodes?: FixtureNode[];
  /** Written as plain Node messages, after the dense block. */
  plainNodes?: FixtureNode[];
  ways?: FixtureWay[];
  relations?: FixtureRelation[];
  replicationTimestamp?: number;
  /** Written as the header's HeaderBBox. */
  bbox?: { south: number; west: number; north: number; east: number };
  compression?: "zlib" | "raw" | "lzma";
}

const MEMBER_TYPES = { node: 0, way: 1, relation: 2 } as const;

type GroupWriter = (g: PbfWriter, sid: (s: string) => number) => void;

export function osmPbfBytes(x: FixtureExtract): Uint8Array {
  const header = new PbfWriter();
  header.writeStringField(4, "OsmSchema-V0.6");
  header.writeStringField(4, "DenseNodes");
  if (x.bbox) {
    const b = x.bbox;
    header.writeMessage(
      1,
      (_: null, m: PbfWriter) => {
        m.writeSVarintField(1, Math.round(b.west * 1e9));
        m.writeSVarintField(2, Math.round(b.east * 1e9));
        m.writeSVarintField(3, Math.round(b.north * 1e9));
        m.writeSVarintField(4, Math.round(b.south * 1e9));
      },
      null,
    );
  }
  if (x.replicationTimestamp !== undefined)
    header.writeVarintField(32, x.replicationTimestamp);
  const parts = [fileBlock("OSMHeader", header.finish(), x.compression)];
  const data = (write: GroupWriter) =>
    parts.push(fileBlock("OSMData", primitiveBlock(write), x.compression));

  if (x.nodes?.length)
    data((g, sid) =>
      g.writeMessage(
        2,
        (_: null, d: PbfWriter) => writeDense(d, x.nodes!, sid),
        null,
      ),
    );
  if (x.plainNodes?.length)
    data((g, sid) => {
      for (const n of x.plainNodes!)
        g.writeMessage(
          1,
          (_: null, m: PbfWriter) => {
            m.writeSVarintField(1, n.id);
            writeTags(m, n.tags, sid);
            m.writeSVarintField(8, Math.round(n.lat * 1e7));
            m.writeSVarintField(9, Math.round(n.lon * 1e7));
          },
          null,
        );
    });
  if (x.ways?.length)
    data((g, sid) => {
      for (const w of x.ways!)
        g.writeMessage(
          3,
          (_: null, m: PbfWriter) => {
            m.writeVarintField(1, w.id);
            writeTags(m, w.tags, sid);
            m.writePackedSVarint(
              8,
              w.refs.map((r, i) => r - (w.refs[i - 1] ?? 0)),
            );
          },
          null,
        );
    });
  if (x.relations?.length)
    data((g, sid) => {
      for (const r of x.relations!)
        g.writeMessage(
          4,
          (_: null, m: PbfWriter) => {
            m.writeVarintField(1, r.id);
            writeTags(m, r.tags, sid);
            m.writePackedVarint(
              8,
              r.members.map((x) => sid(x.role)),
            );
            m.writePackedSVarint(
              9,
              r.members.map((x, i) => x.ref - (r.members[i - 1]?.ref ?? 0)),
            );
            m.writePackedVarint(
              10,
              r.members.map((x) => MEMBER_TYPES[x.type]),
            );
          },
          null,
        );
    });

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function writeTags(
  m: PbfWriter,
  tags: Tags | undefined,
  sid: (s: string) => number,
): void {
  const entries = Object.entries(tags ?? {});
  m.writePackedVarint(
    2,
    entries.map(([k]) => sid(k)),
  );
  m.writePackedVarint(
    3,
    entries.map(([, v]) => sid(v)),
  );
}

function writeDense(
  d: PbfWriter,
  nodes: FixtureNode[],
  sid: (s: string) => number,
): void {
  const ids: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const kv: number[] = [];
  let id = 0;
  let lat = 0;
  let lon = 0;
  for (const n of nodes) {
    const nLat = Math.round(n.lat * 1e7);
    const nLon = Math.round(n.lon * 1e7);
    ids.push(n.id - id);
    lats.push(nLat - lat);
    lons.push(nLon - lon);
    id = n.id;
    lat = nLat;
    lon = nLon;
    for (const [k, v] of Object.entries(n.tags ?? {})) kv.push(sid(k), sid(v));
    kv.push(0);
  }
  d.writePackedSVarint(1, ids);
  d.writePackedSVarint(8, lats);
  d.writePackedSVarint(9, lons);
  d.writePackedVarint(10, kv);
}

function primitiveBlock(write: GroupWriter): Uint8Array {
  const strings = [""];
  const index = new Map<string, number>([["", 0]]);
  const sid = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const group = new PbfWriter();
  write(group, sid);
  const groupBytes = group.finish();
  const block = new PbfWriter();
  const encoder = new TextEncoder();
  block.writeMessage(
    1,
    (list: string[], w: PbfWriter) => {
      for (const s of list) w.writeBytesField(1, encoder.encode(s));
    },
    strings,
  );
  block.writeBytesField(2, groupBytes);
  return block.finish();
}

function fileBlock(
  type: string,
  data: Uint8Array,
  compression: FixtureExtract["compression"] = "zlib",
): Uint8Array {
  const blob = new PbfWriter();
  if (compression === "raw") blob.writeBytesField(1, data);
  else {
    blob.writeVarintField(2, data.length);
    if (compression === "zlib") blob.writeBytesField(3, deflateSync(data));
    else blob.writeBytesField(4, data);
  }
  const blobBytes = blob.finish();
  const head = new PbfWriter();
  head.writeStringField(1, type);
  head.writeVarintField(3, blobBytes.length);
  const headBytes = head.finish();
  const out = new Uint8Array(4 + headBytes.length + blobBytes.length);
  new DataView(out.buffer).setUint32(0, headBytes.length);
  out.set(headBytes, 4);
  out.set(blobBytes, 4 + headBytes.length);
  return out;
}
