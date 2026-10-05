import { describe, expect, it } from "vitest";
import { resolveViewportRequest } from "./viewportRequest";

/** A 2 km route sampled every 500 m. */
const distance = [0, 500, 1000, 1500, 2000];

describe("resolveViewportRequest", () => {
  it("reset wins", () => {
    expect(
      resolveViewportRequest({ reset: true, fromKm: 1 }, distance),
    ).toEqual({ kind: "reset" });
  });

  it("reset needs no distance stream", () => {
    expect(resolveViewportRequest({ reset: true }, undefined)).toEqual({
      kind: "reset",
    });
  });

  it("needs a distance stream", () => {
    expect(resolveViewportRequest({ fromKm: 1 }, undefined)).toEqual({
      kind: "error",
      text: "This track has no recorded distances, so the map cannot be positioned by kilometre. Ask to reset the view instead.",
    });
    expect(resolveViewportRequest({ fromKm: 1 }, [])).toMatchObject({
      kind: "error",
    });
  });

  it("defaults missing bounds to the whole route", () => {
    expect(resolveViewportRequest({}, distance)).toMatchObject({
      kind: "range",
      fromKm: 0,
      toKm: 2,
    });
  });

  it("rejects a window off the route, naming its length", () => {
    const r = resolveViewportRequest({ fromKm: 5, toKm: 6 }, distance);
    expect(r).toEqual({
      kind: "error",
      text: "That stretch is not on this route, which is 2.0 km long.",
    });
  });

  it("returns the index range for a stretch", () => {
    expect(
      resolveViewportRequest({ fromKm: 0.5, toKm: 1.5 }, distance),
    ).toMatchObject({
      kind: "range",
      range: { from: 1, to: 3 },
    });
  });

  it("clamps the reported end to the route length", () => {
    expect(
      resolveViewportRequest({ fromKm: 1.5, toKm: 9 }, distance),
    ).toMatchObject({ kind: "range", fromKm: 1.5, toKm: 2 });
  });

  it("measures the route by the given length when there is one", () => {
    // The activity's own distance, which the rest of the card shows, rather
    // than the last downsampled stream sample.
    expect(resolveViewportRequest({}, distance, 2.04)).toMatchObject({
      toKm: 2.04,
    });
    expect(
      resolveViewportRequest({ fromKm: 5, toKm: 6 }, distance, 2.04),
    ).toMatchObject({
      text: "That stretch is not on this route, which is 2.0 km long.",
    });
  });

  it("ignores bounds that are not numbers", () => {
    expect(
      resolveViewportRequest({ fromKm: "1", toKm: null }, distance),
    ).toMatchObject({ kind: "range", fromKm: 0, toKm: 2 });
  });
});
