import { z } from "zod";

/** Strava ids are opaque digit strings — never used numerically. */
const DIGITS = /^\d+$/;

/**
 * intervals.icu activity ids are opaque digit strings, optionally prefixed
 * with `i` (e.g. `i189807578`, as returned by `list-activities`). Bare
 * digits are also accepted, matching the Strava convention.
 */
const INTERVALS_DIGITS = /^i?\d+$/;

/**
 * Metadata recorded per id schema, so the shared JSON-schema override can
 * recognise a schema produced by `stravaIdInput` or `intervalsActivityIdInput`
 * when the server projects a tool's advertised input schema, and narrow it
 * to the right string pattern.
 */
const idSchemas = z.registry<{ pattern: string }>();

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
 * Covers both `stravaIdInput` and `intervalsActivityIdInput` schemas, each
 * narrowed to its own pattern via `idSchemas`.
 *
 * Pass to `z.toJSONSchema(..., { override })`.
 */
export function stravaIdJsonSchemaOverride(ctx: {
  zodSchema: z.core.$ZodType;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void {
  const meta = idSchemas.get(ctx.zodSchema);
  if (!meta) return;
  const target = ctx.jsonSchema as Record<string, unknown>;
  const { description } = ctx.jsonSchema;
  for (const key of Object.keys(target)) delete target[key];
  target.type = "string";
  target.pattern = meta.pattern;
  if (description !== undefined) target.description = description;
}

/**
 * Appended to every Strava id's description, steering generation toward the
 * quoted digit string the schema advertises.
 *
 * Exported so the guard over the whole advertised surface
 * (`server.integration.test.ts`) matches on this text rather than on a copy
 * of it — a copy would drift and quietly stop identifying which ids actually
 * went through `stravaIdInput`.
 */
export const STRAVA_ID_HINT =
  'Pass the id as a quoted string of digits, exactly as it appears in the Strava URL (e.g. "3516039180561708486") — Strava ids can exceed 2^53, so an unquoted number loses precision.';

/**
 * Appended to every intervals.icu activity id's description, steering
 * generation toward the quoted string form the schema advertises. See
 * `STRAVA_ID_HINT` for why this is exported rather than matched by copy.
 */
export const INTERVALS_ID_HINT =
  'Pass the intervals.icu activity id as a quoted string exactly as shown in list-activities (e.g. "i189807578").';

/**
 * Shared core of `stravaIdInput` and `intervalsActivityIdInput`: a string or
 * safe-integer input, normalised to a string. See `stravaIdInput` for the
 * full rationale; the only per-id-kind pieces are the accepted pattern, the
 * regex-mismatch message, and the description hint.
 */
function idInput(options: {
  description: string;
  pattern: RegExp;
  digitsMessage: string;
  hint: string;
  oversizedNumberHint: string;
}) {
  const { description, pattern, digitsMessage, hint, oversizedNumberHint } =
    options;
  const schema = z
    .union([
      z.string().regex(pattern, digitsMessage),
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
              `id ${value} is too large to be sent as a JSON number, so it was rounded before ` +
              `it reached the server, so the original id is unrecoverable. Re-send the id ` +
              `exactly as ${oversizedNumberHint}, quoted as a string of digits.`,
          });
        }
      }),
    ])
    .transform((value) => String(value))
    .describe(`${description} ${hint}`);
  idSchemas.add(schema, { pattern: pattern.source });
  return schema;
}

/**
 * Tool-input schema for a Strava resource id (activity, athlete).
 *
 * Strava ids are 64-bit and some already exceed `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1). An id sent as a JSON number can lose precision in the host's
 * JSON round-trip before validation ever sees it, so the digit-string form is
 * the only lossless representation for those, and the only one advertised to
 * hosts (`stravaIdJsonSchemaOverride`).
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
export const stravaIdInput = (description: string) =>
  idInput({
    description,
    pattern: DIGITS,
    digitsMessage: "id must be a string of digits",
    hint: STRAVA_ID_HINT,
    oversizedNumberHint: "it appears in the Strava URL",
  });

/**
 * Tool-input schema for an intervals.icu activity id.
 *
 * intervals.icu activity ids are digit strings, optionally prefixed with `i`
 * (e.g. `i189807578`, the form `list-activities` returns); bare digits are
 * also accepted. Shares `stravaIdInput`'s string-or-safe-integer-number
 * runtime shape and string-only advertised schema (`stravaIdJsonSchemaOverride`),
 * for the same reason: a host cannot generate the lossy number branch for an
 * id that has already grown past 2^53.
 */
export const intervalsActivityIdInput = (description: string) =>
  idInput({
    description,
    pattern: INTERVALS_DIGITS,
    digitsMessage:
      'id must be a string of digits, optionally prefixed with "i"',
    hint: INTERVALS_ID_HINT,
    oversizedNumberHint: "returned by list-activities",
  });
