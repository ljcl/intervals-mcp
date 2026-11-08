import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import noRouteFixture from "./__fixtures__/ors/error-no-route.json";
import geocodeFixture from "./__fixtures__/ors/geocode-sf.json";
import roundTripFixture from "./__fixtures__/ors/round-trip-sf.json";
import { CallCancelledError } from "./callScope";
import { HttpError, orsApi } from "./fetchClient";
import {
  GEOCODE_CIRCLE_KM,
  GEOCODE_HITS,
  geocode,
  OrsApiError,
  orsRoute,
  parseOrsRoute,
  ROUND_TRIP_POINTS,
} from "./orsClient";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    orsApi: { get: vi.fn(), post: vi.fn() },
  };
});

const post = vi.mocked(orsApi.post);
const get = vi.mocked(orsApi.get);

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe("parseOrsRoute", () => {
  it("turns the GeoJSON into a lat,lng track with path share and way names", () => {
    const route = parseOrsRoute(JSON.stringify(roundTripFixture));
    const summary = roundTripFixture.features[0]!.properties.summary.distance;
    const [lng, lat] = roundTripFixture.features[0]!.geometry.coordinates[0]!;
    expect(route.track.coordinates[0]).toEqual([lat, lng]);
    expect(route.track.distance.length).toBe(route.track.coordinates.length);
    expect(Math.abs(route.track.distance.at(-1)! - summary)).toBeLessThan(
      summary * 0.02,
    );
    expect(route.distance_m).toBe(summary);
    expect(route.track.altitude.some((a) => a !== null)).toBe(true);
    expect(route.path_share).toBeGreaterThanOrEqual(0);
    expect(route.path_share).toBeLessThanOrEqual(1);
    expect(route.way_names.length).toBeLessThanOrEqual(4);
    expect(route.way_names).not.toContain("-");
    expect(route.way_names).not.toContain("");
    expect(route.ferry_m).toBe(0);
  });

  it("reports the metres on a ferry (waytype 9)", () => {
    const ferry = structuredClone(roundTripFixture);
    ferry.features[0]!.properties.extras.waytype.summary.push({
      value: 9,
      distance: 2400.5,
      amount: 25,
    });
    expect(parseOrsRoute(JSON.stringify(ferry)).ferry_m).toBe(2400.5);
  });

  it("throws the invalid-response error for a body that is not JSON", () => {
    expect(() => parseOrsRoute("<html>busy</html>")).toThrow(
      "read a route: invalid OpenRouteService response",
    );
  });
});

describe("orsRoute", () => {
  it("posts a round trip in lng,lat order as a read", async () => {
    post.mockResolvedValue({ data: JSON.stringify(roundTripFixture) });
    await orsRoute("key", {
      waypoints: [[37.7955, -122.3937]],
      roundTrip: { length_m: 6000.4, seed: 7 },
    });
    const [url, body, config] = post.mock.calls[0]!;
    expect(url).toBe("/v2/directions/foot-walking/geojson");
    expect(body).toEqual({
      coordinates: [[-122.3937, 37.7955]],
      elevation: true,
      instructions: true,
      extra_info: ["waytype"],
      options: {
        avoid_features: ["ferries"],
        round_trip: { length: 6000, points: ROUND_TRIP_POINTS, seed: 7 },
      },
    });
    expect(config).toMatchObject({
      readOnly: true,
      responseType: "text",
      headers: { Authorization: "key" },
    });
  });

  it("avoids ferries between places too", async () => {
    post.mockResolvedValue({ data: JSON.stringify(roundTripFixture) });
    await orsRoute("key", {
      waypoints: [
        [37.7955, -122.3937],
        [37.8, -122.4],
      ],
    });
    expect(post.mock.calls[0]![1]).toMatchObject({
      options: { avoid_features: ["ferries"] },
    });
    expect(post.mock.calls[0]![1]).not.toHaveProperty("options.round_trip");
  });

  it("rethrows a cancellation without the request URL", async () => {
    post.mockRejectedValue(
      new CallCancelledError(
        "Request to https://api.openrouteservice.org/v2/directions?x=37.7955,-122.3937",
      ),
    );
    const error = await orsRoute("key", { waypoints: [[37.7955, -122.3937]] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallCancelledError);
    expect((error as Error).message).toBe(
      "Routing stopped: the tool call was cancelled.",
    );
    expect((error as Error).message).not.toMatch(/\d+\.\d+/);
  });

  it("wraps an HTTP failure with its status and the ORS message", async () => {
    post.mockRejectedValue(
      new HttpError("Request failed", {
        status: 404,
        statusText: "Not Found",
        data: JSON.stringify(noRouteFixture),
        contentType: "application/json",
      }),
    );
    const error = await orsRoute("key", { waypoints: [[37.7, -122.7]] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrsApiError);
    expect((error as OrsApiError).response.status).toBe(404);
  });

  it("passes a rate limit through unchanged", async () => {
    const limit = handledRateLimit("orsRoute");
    post.mockRejectedValue(limit);
    await expect(orsRoute("key", { waypoints: [[1, 2]] })).rejects.toBe(limit);
  });
});

describe("geocode", () => {
  it("returns the first hit as lat,lng with its label and sends the focus", async () => {
    get.mockResolvedValue({ data: JSON.stringify(geocodeFixture) });
    const place = await geocode(
      "key",
      "Embarcadero, San Francisco",
      [37.79, -122.4],
    );
    const feature = geocodeFixture.features[0]!;
    expect(place).toEqual({
      label: feature.properties.label,
      point: [feature.geometry.coordinates[1], feature.geometry.coordinates[0]],
      match: {
        query: "Embarcadero, San Francisco",
        name: "The Embarcadero",
        type: "street",
        missing: [],
      },
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]).toMatchObject({
      params: {
        text: "Embarcadero, San Francisco",
        size: GEOCODE_HITS,
        layers: "venue,address,street",
        "focus.point.lat": 37.79,
        "focus.point.lon": -122.4,
        "boundary.circle.lat": 37.79,
        "boundary.circle.lon": -122.4,
        "boundary.circle.radius": GEOCODE_CIRCLE_KM,
      },
    });
  });

  it("rethrows a cancellation without the focus point", async () => {
    get.mockRejectedValue(
      new CallCancelledError(
        "Request to https://api.openrouteservice.org/geocode/search?focus.point.lat=37.79",
      ),
    );
    const error = await geocode("key", "Embarcadero", [37.79, -122.4])
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallCancelledError);
    expect((error as Error).message).toBe(
      "Looking up a place stopped: the tool call was cancelled.",
    );
    expect((error as Error).message).not.toMatch(/\d+\.\d+/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("falls back to any layer when no venue, address or street matches", async () => {
    get
      .mockResolvedValueOnce({ data: { features: [] } })
      .mockResolvedValueOnce({
        data: {
          features: [
            {
              geometry: { coordinates: [151.21, -33.87] },
              properties: {
                label: "Sydney, NSW, Australia",
                name: "Sydney",
                layer: "locality",
              },
            },
          ],
        },
      });
    const place = await geocode("key", "Anzac Bridge", [37.79, -122.4]);
    expect(place).toEqual({
      label: "Sydney, NSW, Australia",
      point: [-33.87, 151.21],
      match: {
        query: "Anzac Bridge",
        name: "Sydney",
        type: "locality",
        missing: ["anzac", "bridge"],
      },
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]![1]!.params).not.toHaveProperty("layers");
    expect(get.mock.calls[1]![1]!.params).not.toHaveProperty(
      "boundary.circle.radius",
    );
  });

  const hit = (name: string, layer: string, props: object = {}) => ({
    geometry: { coordinates: [151.19, -33.86] },
    properties: {
      label: `${name}, Pyrmont, NSW, Australia`,
      name,
      layer,
      ...props,
    },
  });

  it("takes the first hit with every word of the text", async () => {
    // Live ORS order for "Pirrama Park" (8 Nov 2026): the road outranks the park.
    get.mockResolvedValue({
      data: {
        features: [
          hit("Pirrama Road", "street"),
          hit("48 Pirrama Road", "address"),
          hit("Pirrama Park", "venue"),
        ],
      },
    });
    const place = await geocode("key", "Pirrama Park", [-33.89, 151.19]);
    expect(place!.match).toEqual({
      query: "Pirrama Park",
      name: "Pirrama Park",
      type: "venue",
      missing: [],
    });
  });

  it("names the words the top hit lacks when no hit has them all", async () => {
    get.mockResolvedValue({
      data: {
        features: [
          hit("Foreshore Promenade", "street"),
          hit("Foreshore Road", "street"),
        ],
      },
    });
    const place = await geocode(
      "key",
      "Glebe Foreshore Walk",
      [-33.89, 151.19],
    );
    expect(place!.match).toMatchObject({
      name: "Foreshore Promenade",
      missing: ["glebe", "walk"],
    });
  });

  it("matches street abbreviations, accents, case, joining words and the county", async () => {
    get.mockResolvedValue({
      data: {
        features: [
          hit("ANZAC Bridge Shared Pedestrian and Bicycle Path", "street", {
            county: "Sydney",
          }),
          hit("Pirrama Road", "street"),
          hit("Café Saint Mary's", "venue"),
        ],
      },
    });
    const name = async (text: string) =>
      (await geocode("key", text, [-33.89, 151.19]))!.match!.name;
    expect(await name("the Anzac bridge, Sydney")).toBe(
      "ANZAC Bridge Shared Pedestrian and Bicycle Path",
    );
    expect(await name("Pirrama Rd")).toBe("Pirrama Road");
    expect(await name("cafe St Marys")).toBe("Café Saint Mary's");
  });

  it("is null when nothing matches", async () => {
    get.mockResolvedValue({ data: { features: [] } });
    expect(await geocode("key", "zzzz", [37.79, -122.4])).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("makes one unfiltered request without a focus point", async () => {
    get.mockResolvedValue({ data: { features: [] } });
    expect(await geocode("key", "zzzz", null)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]!.params).not.toHaveProperty("layers");
  });
});
