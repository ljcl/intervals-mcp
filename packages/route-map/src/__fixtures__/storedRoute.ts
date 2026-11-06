import {
  type RouteMapData,
  type RouteMapRoute,
  type RouteSegment,
  type RouteVia,
} from "../types";

/**
 * A stored route (`source` "route") shaped like the server's
 * `buildStoredRouteMapData` payload. Synthetic: an approximate 13 km loop
 * from Rozelle round Iron Cove, through Balmain, and out and back over
 * Anzac Bridge to Pyrmont, in Sydney. Not a recorded track.
 */

interface Anchor {
  at: [number, number];
  /** A via point the route goes through at this anchor. */
  via?: { id: string; label: string; kind: RouteVia["kind"] };
}

const ANCHORS: Anchor[] = [
  { at: [-33.8625, 151.1715] }, // 0 Rozelle
  { at: [-33.866, 151.165] },
  { at: [-33.866, 151.153] }, // 2 Iron Cove, Leichhardt side
  { at: [-33.864, 151.142] },
  { at: [-33.856, 151.1405] },
  {
    at: [-33.8545, 151.152],
    via: { id: "v1", label: "Iron Cove Bridge", kind: "via" },
  }, // 5
  { at: [-33.8585, 151.157] }, // 6
  {
    at: [-33.856, 151.172],
    via: { id: "v2", label: "Darling St, Balmain", kind: "via" },
  }, // 7
  { at: [-33.868, 151.1765] }, // 8 Rozelle Bay
  { at: [-33.869, 151.184] }, // 9 Anzac Bridge, west end
  {
    at: [-33.87, 151.199],
    via: { id: "v3", label: "Pyrmont", kind: "turnaround" },
  }, // 10
  { at: [-33.869, 151.184] }, // 11
  { at: [-33.868, 151.1765] }, // 12
  { at: [-33.8625, 151.1715] }, // 13 back at the start
];

/** Points per leg are spaced about this far apart, metres. */
const STEP_M = 60;

function haversine(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const round = (value: number, decimals: number) =>
  Math.round(value * 10 ** decimals) / 10 ** decimals;

interface Track {
  coordinates: Array<[number, number]>;
  distance: number[];
  /** Index of each anchor in `coordinates`. */
  anchorIndex: number[];
}

function buildTrack(anchors: Anchor[]): Track {
  const coordinates: Array<[number, number]> = [anchors[0]!.at];
  const distance = [0];
  const anchorIndex = [0];
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1]!.at;
    const to = anchors[i]!.at;
    const steps = Math.max(1, Math.round(haversine(from, to) / STEP_M));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const point: [number, number] = [
        round(from[0] + (to[0] - from[0]) * t, 5),
        round(from[1] + (to[1] - from[1]) * t, 5),
      ];
      distance.push(
        round(
          distance[distance.length - 1]! +
            haversine(coordinates[coordinates.length - 1]!, point),
          1,
        ),
      );
      coordinates.push(point);
    }
    anchorIndex.push(coordinates.length - 1);
  }
  return { coordinates, distance, anchorIndex };
}

const track = buildTrack(ANCHORS);
const km = (index: number) => round(track.distance[index]! / 1000, 3);
const at = (anchor: number) => track.anchorIndex[anchor]!;
const totalM = track.distance[track.distance.length - 1]!;

/** Indices of the first point at or past `metres`. */
function indexAt(metres: number): number {
  const i = track.distance.findIndex((d) => d >= metres);
  return i < 0 ? track.distance.length - 1 : i;
}

function segment(
  index: number,
  kind: RouteSegment["kind"],
  label: string,
  fromAnchor: number,
  toAnchor: number,
  extra: Partial<RouteSegment> = {},
): RouteSegment {
  return {
    index,
    kind,
    label,
    from_km: km(at(fromAnchor)),
    to_km: km(at(toAnchor)),
    startIndex: at(fromAnchor),
    endIndex: at(toAnchor),
    climb_m: 18,
    path_share: 0.6,
    notes: [],
    ...extra,
  };
}

const SEGMENTS: RouteSegment[] = [
  segment(0, "route", "Rozelle to Iron Cove", 0, 2),
  segment(1, "activity", "Bay Run, from a past run", 2, 6, {
    climb_m: 12,
    path_share: 0.95,
  }),
  segment(2, "generated", "Balmain and Rozelle Bay", 6, 8),
  segment(3, "out_and_back", "Out and back over Anzac Bridge", 8, 12, {
    climb_m: 46,
  }),
  segment(4, "join", "Home via Lilyfield", 12, 13, {
    climb_m: null,
    path_share: null,
  }),
];

const VIAS: RouteVia[] = ANCHORS.flatMap((anchor, i) =>
  anchor.via
    ? [
        {
          ...anchor.via,
          km: km(at(i)),
          index: at(i),
          point: anchor.at,
        },
      ]
    : [],
);

const KM_MARKERS: RouteMapRoute["kmMarkers"] = [];
for (let k = 1; k * 1000 < totalM; k++)
  KM_MARKERS.push({ km: k, index: indexAt(k * 1000) });

const VERSIONS: RouteMapRoute["versions"] = [
  { version: 1, change: "Stitched from 4 parts" },
  { version: 2, change: "Through Darling St, Balmain" },
  { version: 3, change: "Added an out and back to Pyrmont" },
];

const altitude = track.distance.map((d) =>
  round(8 + 20 * Math.sin(d / 1900) ** 2 + 5 * Math.sin(d / 430), 1),
);

/** The route's anchor at Anzac Bridge's west end, km from the start. */
const anzacKm = km(at(9));

function storedRoute(route: Partial<RouteMapRoute> = {}): RouteMapData {
  const coordinates = track.coordinates;
  return {
    source: "route",
    id: "r7k2m9qx4a",
    name: "Rozelle, Bay Run and Pyrmont (v3)",
    activityType: "Run",
    distance: Math.round(totalM),
    elevationGain: 128,
    coordinates,
    start: coordinates[0]!,
    end: coordinates[coordinates.length - 1]!,
    streams: { distance: track.distance, altitude },
    annotations: {
      waypoints: [
        {
          index: indexAt(anzacKm * 1000),
          endIndex: at(10),
          km: anzacKm,
          end_km: km(at(10)),
          label: "Anzac Bridge climb +35 m",
          kind: "climb",
        },
        {
          index: indexAt(6000),
          km: 6,
          label: "Water, Iron Cove",
          kind: "water",
        },
      ],
    },
    route: {
      route_id: "r7k2m9qx4a",
      version: 3,
      latest_version: 3,
      versions: VERSIONS,
      editable: true,
      segments: SEGMENTS,
      vias: VIAS,
      kmMarkers: KM_MARKERS,
      warnings: [],
      ...route,
    },
  };
}

/** Version 3 of 3: editable, five sections, three via points. */
export const storedRouteMap: RouteMapData = storedRoute();

/** Version 2 of 3: an older version, so it cannot be changed. */
export const olderStoredRouteMap: RouteMapData = {
  ...storedRoute({ version: 2, editable: false }),
  name: "Rozelle, Bay Run and Pyrmont (v2)",
};

/** Version 3 drawn over version 2, which had no out and back. */
export const comparedStoredRouteMap: RouteMapData = (() => {
  const outAndBack = SEGMENTS[3]!;
  const coordinates = track.coordinates;
  const older = [
    ...coordinates.slice(0, outAndBack.startIndex + 1),
    ...coordinates.slice(outAndBack.endIndex + 1),
  ];
  const lengthM = Math.round(
    track.distance[outAndBack.endIndex]! -
      track.distance[outAndBack.startIndex]!,
  );
  return storedRoute({
    compare: {
      version: 2,
      coordinates: older,
      change: {
        from_version: 2,
        to_version: 3,
        distance_change_m: lengthM,
        changed: true,
        from_km: outAndBack.from_km,
        to_km: outAndBack.to_km,
        old_from_km: outAndBack.from_km,
        old_to_km: outAndBack.from_km,
      },
      startIndex: outAndBack.startIndex,
      endIndex: outAndBack.endIndex,
    },
  });
})();

/** Version 3 with section notes and a waypoint the server moved. */
export const warnedStoredRouteMap: RouteMapData = {
  ...storedRoute({
    warnings: [
      {
        from_km: SEGMENTS[4]!.from_km,
        to_km: SEGMENTS[4]!.to_km,
        text: "No altitude for this part, so its climb is not counted.",
      },
      {
        from_km: SEGMENTS[2]!.from_km,
        to_km: SEGMENTS[2]!.to_km,
        text: "Generated: the path share is an estimate.",
      },
    ],
  }),
  waypointWarnings: [
    'Pin "Water, Iron Cove" moved from km 5.6 (version 2) to km 6 (version 3).',
  ],
};
