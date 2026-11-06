import { LoadingState, Skeleton } from "@intervals-mcp/ui";

/** The route map's loading branch, with the server's progress line if any. */
export function LoadingSkeleton({
  label = "Loading route map",
  progress,
}: {
  label?: string;
  progress?: string | null;
}) {
  return (
    <LoadingState label={label} progress={progress}>
      <Skeleton variant="bar" />
      <Skeleton variant="chart" />
    </LoadingState>
  );
}
