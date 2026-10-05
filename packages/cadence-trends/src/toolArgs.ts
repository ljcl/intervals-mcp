import { toolArgRecord } from "@intervals-mcp/ui";

/** The server's default window for `view-cadence-trends`, in days. */
export const DEFAULT_DAYS = 42;

/** The app's arguments, normalised from the host's raw tool arguments. */
export interface ToolArgs {
  days: number;
}

/** A finite number, from a number or a numeric string; else undefined. */
function numberArg(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Host tool arguments are the model's raw arguments, so the legacy `weeks`
 * is read too, as `weeks * 7` days. Every argument is optional, so this never
 * returns null: the window falls back to {@link DEFAULT_DAYS}.
 */
export function parseToolArgs(raw: unknown): ToolArgs {
  const args = toolArgRecord(raw);
  const weeks = numberArg(args.weeks);
  return {
    days:
      numberArg(args.days) ??
      (weeks === undefined ? undefined : weeks * 7) ??
      DEFAULT_DAYS,
  };
}
