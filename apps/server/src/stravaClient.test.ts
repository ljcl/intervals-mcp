import { describe, expect, it } from "vitest";
import * as fixtures from "./__fixtures__";
import { parseJsonWithLargeInts } from "./fetchClient";
import { DetailedActivitySchema, SummarySegmentSchema } from "./stravaClient";

describe("DetailedActivitySchema", () => {
  it("parses a basic run activity", () => {
    const result = DetailedActivitySchema.safeParse(fixtures.basicRunActivity);
    expect(result.success).toBe(true);
  });

  it("parses activity with null optional fields", () => {
    const result = DetailedActivitySchema.safeParse(
      fixtures.activityWithNullOptionals,
    );
    expect(result.success).toBe(true);
  });

  it("parses virtual run activity", () => {
    const result = DetailedActivitySchema.safeParse(
      fixtures.virtualRunActivity,
    );
    expect(result.success).toBe(true);
  });

  it("parses ride activity with power data", () => {
    const result = DetailedActivitySchema.safeParse(fixtures.rideActivity);
    expect(result.success).toBe(true);
  });

  it("parses activity with segment efforts", () => {
    const result = DetailedActivitySchema.safeParse(
      fixtures.activityWithSegmentEfforts,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.segment_efforts?.length).toBe(3);
    }
  });

  it("rejects activity missing required fields", () => {
    const { id, ...incomplete } = fixtures.basicRunActivity;
    const result = DetailedActivitySchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  // Regression: Strava issues segment-effort ids beyond Number.MAX_SAFE_INTEGER.
  // The default JSON parse rounds them and z.number().int() rejected them,
  // which blocked every read/write on activities that have such efforts.
  it("accepts a segment-effort id beyond MAX_SAFE_INTEGER without precision loss", () => {
    const bigEffortId = "3503400000123456789";
    // Mirror the real fetch path: raw JSON text -> precision-preserving parse.
    const raw = JSON.stringify(fixtures.activityWithSegmentEfforts).replace(
      "700000001",
      bigEffortId,
    );
    const parsed = parseJsonWithLargeInts(raw);

    const result = DetailedActivitySchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.segment_efforts?.[0]?.id).toBe(bigEffortId);
      // Safe ids are normalised to strings too, so ids are a consistent type.
      expect(result.data.id).toBe(
        String(fixtures.activityWithSegmentEfforts.id),
      );
    }
  });

  it("normalises numeric ids to strings", () => {
    const result = DetailedActivitySchema.safeParse(fixtures.basicRunActivity);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(String(fixtures.basicRunActivity.id));
      expect(result.data.athlete.id).toBe(
        String(fixtures.basicRunActivity.athlete.id),
      );
    }
  });
});

describe("SummarySegmentSchema", () => {
  it("parses summary segment", () => {
    const result = SummarySegmentSchema.safeParse(fixtures.summarySegment);
    expect(result.success).toBe(true);
  });

  it("parses segment with null optionals", () => {
    const result = SummarySegmentSchema.safeParse(
      fixtures.segmentWithNullOptionals,
    );
    expect(result.success).toBe(true);
  });
});
