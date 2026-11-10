// The wire types are shared with the server's feed through @intervals-mcp/data.
export type {
  WellnessTrendData,
  WellnessTrendPoint,
} from "@intervals-mcp/data";

/** view-wellness arguments, after `windowToolArgs`. Both optional. */
export type WellnessToolArgs = {
  oldest?: string;
  newest?: string;
};
