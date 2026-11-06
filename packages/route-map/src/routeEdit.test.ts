import { describe, expect, it } from "vitest";
import { storedRouteMap } from "./__fixtures__/storedRoute";
import {
  appliedSummary,
  describeOperation,
  fallbackMessage,
  formatLatLng,
  isLegacyRefusal,
  kmAtIndex,
  nearestRouteKm,
  readAmendResult,
} from "./routeEdit";

const text = (t: string) => [{ type: "text", text: t }];

describe("formatLatLng", () => {
  it("gives 5 decimals", () => {
    expect(formatLatLng(-33.8612345, 151.17)).toBe("-33.86123,151.17000");
  });
});

describe("nearestRouteKm", () => {
  it("is the km of the track point nearest the place", () => {
    const [lat, lng] = storedRouteMap.coordinates[25]!;
    expect(nearestRouteKm(storedRouteMap, lat + 0.00005, lng)).toBe(
      Math.round(storedRouteMap.streams!.distance![25]!) / 1000,
    );
  });

  it("is null with no track or no distance", () => {
    expect(
      nearestRouteKm({ ...storedRouteMap, coordinates: [] }, -33.86, 151.17),
    ).toBeNull();
    expect(kmAtIndex({ ...storedRouteMap, streams: {} }, 3)).toBeNull();
  });
});

describe("describeOperation", () => {
  it("says what each operation does", () => {
    expect(describeOperation({ op: "insert_via", km: 3.24, place: "x" })).toBe(
      "Add a point near km 3.2",
    );
    expect(describeOperation({ op: "remove_via", via_id: "v2" })).toBe(
      "Remove point v2",
    );
    expect(describeOperation({ op: "move_via", via_id: "v1", to: "y" })).toBe(
      "Move point v1",
    );
    expect(
      describeOperation({
        op: "replace_section",
        from_km: 3,
        to_km: 4.5,
        through: "Callan Park",
      }),
    ).toBe("Replace 3.0–4.5 km through Callan Park");
    expect(
      describeOperation({ op: "replace_section", from_km: 3, to_km: 4.5 }),
    ).toBe("Replace 3.0–4.5 km");
  });
});

describe("readAmendResult", () => {
  it("reads a new version", () => {
    expect(
      readAmendResult(
        {
          content: text("ok"),
          structuredContent: {
            applied: true,
            version: 5,
            change: {
              distance_change_m: 120,
              changed: true,
              from_km: 2,
              to_km: 3.5,
            },
            warnings: ["Path share is low.", 7],
          },
        },
        "r1",
      ),
    ).toEqual({
      kind: "applied",
      version: 5,
      summary: "Route r1 is now version 5 (2.0–3.5 km changed, +120 m).",
      warnings: ["Path share is low."],
    });
  });

  it("reads a result that stored nothing", () => {
    expect(
      readAmendResult(
        {
          content: text("no"),
          structuredContent: { applied: false, warnings: ["Out of budget."] },
        },
        "r1",
      ),
    ).toEqual({ kind: "not_applied", warnings: ["Out of budget."] });
    expect(
      readAmendResult(
        { content: text("no"), structuredContent: { applied: false } },
        "r1",
      ),
    ).toMatchObject({ kind: "not_applied", warnings: [expect.any(String)] });
  });

  it("passes the server's error text through", () => {
    expect(
      readAmendResult({ isError: true, content: text("❌ Not found.") }, "r1"),
    ).toEqual({ kind: "error", text: "❌ Not found." });
    expect(readAmendResult({ isError: true }, "r1")).toEqual({
      kind: "error",
      text: "❌ amend-route failed.",
    });
  });

  it("knows the 2025-revision refusal", () => {
    const refusal =
      "❌ amend-route changes data, and this client connects with a 2025 protocol revision, so the server does not run it.";
    expect(isLegacyRefusal(refusal)).toBe(true);
    expect(
      readAmendResult({ isError: true, content: text(refusal) }, "r1").kind,
    ).toBe("legacy_refused");
  });

  it("is an error when the result has no structured content or version", () => {
    expect(readAmendResult({ content: text("ok") }, "r1").kind).toBe("error");
    expect(
      readAmendResult({ structuredContent: { applied: true } }, "r1").kind,
    ).toBe("error");
  });
});

describe("appliedSummary", () => {
  it("reads without a change, or with the same line", () => {
    expect(appliedSummary("r1", 2, null)).toBe("Route r1 is now version 2.");
    expect(
      appliedSummary("r1", 2, {
        distance_change_m: 0,
        changed: false,
        from_km: 0,
        to_km: 0,
      }),
    ).toBe(
      "Route r1 is now version 2 (the line is the same, no change in distance).",
    );
  });
});

describe("fallbackMessage", () => {
  it("asks the chat to apply the exact request", () => {
    expect(
      fallbackMessage({
        route_id: "r1",
        base_version: 3,
        operations: [{ op: "remove_via", via_id: "v2" }],
      }),
    ).toBe(
      'Please apply this change with amend-route: {"route_id":"r1","base_version":3,"operations":[{"op":"remove_via","via_id":"v2"}]}',
    );
  });
});
