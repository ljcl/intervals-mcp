import { z } from "zod";

/** Strava ids are opaque digit strings — never used numerically. */
const DIGITS = /^\d+$/;

/**
 * Schemas produced by `stravaIdInput`, so `stravaIdJsonSchemaOverride` can
 * recognise them when the server projects a tool's advertised input schema.
 */
const stravaIds = z.registry<{ isStravaId: true }>();

/**
 * Rewrite an id's advertised JSON Schema to the *string* form only.
 *
 * The runtime schema is a string-or-number union (see below), and zod's
 * `io: "input"` projection would faithfully advertise both branches as
 * `anyOf: [{type: "string"}, {type: "integer", maximum: 9007199254740991}]`.
 * That is accurate and useless: a model copying `3516039180561708486` out of a
 * Strava URL sees a number-shaped id and emits the number branch, the host's
 * `JSON.parse` rounds it to `3516039180561708500` on the way in, and the call
 * fails validation with the true digits already unrecoverable. Neither the
 * branch's `maximum` nor the description reliably steers generation away from
 * the number form.
 *
 * Advertising a single `type: "string"` removes the trap at the source: the
 * only shape a host can generate from the schema is the quoted digit string,
 * which is lossless for every id. The union stays at runtime, so a host that
 * already sends `activity_id: 12345` keeps working.
 *
 * Pass to `z.toJSONSchema(..., { override })`.
 */
export function stravaIdJsonSchemaOverride(ctx: {
  zodSchema: z.core.$ZodType;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void {
  if (!stravaIds.has(ctx.zodSchema)) return;
  const target = ctx.jsonSchema as Record<string, unknown>;
  const { description } = ctx.jsonSchema;
  for (const key of Object.keys(target)) delete target[key];
  target.type = "string";
  target.pattern = DIGITS.source;
  if (description !== undefined) target.description = description;
}

/**
 * Appended to every id's description, steering generation toward the quoted
 * digit string the schema advertises.
 *
 * Exported so the guard over the whole advertised surface
 * (`server.integration.test.ts`) matches on this text rather than on a copy
 * of it — a copy would drift and quietly stop identifying which ids actually
 * went through `stravaIdInput`.
 */
export const STRAVA_ID_HINT =
  'Pass the id as a quoted string of digits, exactly as it appears in the Strava URL (e.g. "3516039180561708486") — Strava ids can exceed 2^53, so an unquoted number loses precision.';

/**
 * Tool-input schema for a Strava resource id (activity, segment, effort,
 * athlete, route).
 *
 * Strava ids are 64-bit and both segment-effort and newer route ids already
 * exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1). An id sent as a JSON number can
 * lose precision in the host's JSON round-trip before validation ever sees it,
 * so the digit-string form is the only lossless representation for those — and
 * the only one advertised to hosts (`stravaIdJsonSchemaOverride`).
 *
 * At runtime the schema accepts either form and normalises to a string:
 *
 * - A digit string is always accepted and passes through unchanged — this is
 *   the lossless form and the one hosts are told to send.
 * - A bare number is accepted only when it is a non-negative *safe* integer,
 *   in which case it is coerced to its digit string. Most activity ids sit
 *   well below 2^53, so this is exactly the everyday case where a host or model
 *   emits `activity_id: 12345`; rejecting it outright (the original string-only
 *   behaviour) left callers stuck between "expected string, received number"
 *   and quoting the digits into a non-digit string.
 * - A number that is not a safe integer is rejected. By the time such a value
 *   reaches zod it has already been rounded by the host's `JSON.parse` (e.g.
 *   `3516039180561708486` -> `3516039180561708500`), so accepting it would
 *   silently fetch the wrong resource — or, far more likely, 404. The error
 *   names the rounded value and asks for the original digits as a string,
 *   because that is the only thing the caller can act on.
 *
 * Ids are opaque identifiers, never used numerically, so coercing a safe
 * integer to its string loses nothing. The fetch layer reports ids as exact
 * strings (see `parseJsonWithLargeInts`), so string ids round-trip cleanly.
 */
export const stravaIdInput = (description: string) => {
  const schema = z
    .union([
      z.string().regex(DIGITS, "id must be a string of digits"),
      z.number().superRefine((value, ctx) => {
        if (!Number.isInteger(value) || value < 0) {
          ctx.addIssue({
            code: "custom",
            message: "id must be a non-negative whole number",
          });
          return;
        }
        if (!Number.isSafeInteger(value)) {
          ctx.addIssue({
            code: "custom",
            message:
              `id ${value} is too large to be sent as a JSON number — it was rounded before ` +
              `it reached the server, so the original id is unrecoverable. Re-send the id ` +
              `exactly as it appears in the Strava URL, quoted as a string of digits.`,
          });
        }
      }),
    ])
    .transform((value) => String(value))
    .describe(`${description} ${STRAVA_ID_HINT}`);
  stravaIds.add(schema, { isStravaId: true });
  return schema;
};
