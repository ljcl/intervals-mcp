import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { LoadingState } from "./LoadingState";
import { Skeleton } from "./Skeleton";

const meta = preview.meta({
  component: LoadingState,
});

export const Default = meta.story({
  render: () => (
    <LoadingState label="Loading activity chart">
      <Skeleton variant="chart" />
    </LoadingState>
  ),
});

export const Dark = meta.story({
  globals: darkGlobals,
  render: () => (
    <LoadingState label="Loading activity chart">
      <Skeleton variant="chart" />
    </LoadingState>
  ),
});

/**
 * A long server-side scan reports what it is doing (#279). The line sits
 * inside the same status region as the label, so each update is announced.
 */
export const WithProgress = meta.story({
  render: () => (
    <LoadingState
      label="Loading fitness trend"
      progress="Listed 400 activities"
    >
      <Skeleton variant="bar" />
      <Skeleton variant="chart" />
    </LoadingState>
  ),
});

export const WithProgressDark = meta.story({
  globals: darkGlobals,
  render: () => (
    <LoadingState
      label="Loading fitness trend"
      progress="Reading 87 of 120 activities"
    >
      <Skeleton variant="bar" />
      <Skeleton variant="chart" />
    </LoadingState>
  ),
});
