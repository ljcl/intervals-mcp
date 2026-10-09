/**
 * intervals.icu connection settings. The only module that reads the
 * INTERVALS_* env vars, so tools and the HTTP layer never touch process.env
 * for credentials (envScaffolding.test.ts enforces this).
 *
 * Auth is a personal API key sent as HTTP Basic with the literal username
 * `API_KEY`. Athlete id `0` means "the key's own athlete".
 *
 * checkConfig() is the startup gate for the server's environment variables.
 * index.ts runs it first, so a bad value stops startup with a message that
 * names the variable, rather than failing later inside a tool call.
 *
 * getTimeZone() is the one home for the zone every local date uses. It also
 * holds the athlete's zone that athleteTimeZone.ts reads from intervals.icu
 * at startup. The state lives here, so no caller changes and config.ts never
 * imports the client.
 */
import { isValidTimeZone } from "./utils/localDate";

export const DEFAULT_PORT = 3000;

const MIN_AUTH_TOKEN_LENGTH = 32;
const ATHLETE_ID_RE = /^(?:0|i?\d+)$/;
const PORT_RE = /^\d+$/;
const MAX_QUOTED_CHARS = 64;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "INTERVALS_API_KEY is not set. Add your intervals.icu API key (Settings, Developer Settings) to the server environment and restart the server.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function getIntervalsApiKey(): string {
  const key = process.env.INTERVALS_API_KEY?.trim();
  if (!key) throw new MissingApiKeyError();
  return key;
}

export function apiKeyConfigured(): boolean {
  return Boolean(process.env.INTERVALS_API_KEY?.trim());
}

export function getIntervalsAthleteId(): string {
  return process.env.INTERVALS_ATHLETE_ID?.trim() || "0";
}

/** Where the zone came from: TZ, the athlete's setting, or the process. */
export type TimeZoneSource = "env" | "intervals.icu" | "fallback";

export interface TimeZoneSetting {
  zone: string;
  source: TimeZoneSource;
}

/**
 * The TZ value that means "not chosen". docker-compose.yml injects
 * `TZ=${TZ:-UTC}`, so an operator who never set TZ arrives with exactly this.
 * Any other zone, Etc/UTC included, is a choice; Etc/UTC pins UTC.
 */
const FOLLOW_ATHLETE_TZ = "UTC";

/** The athlete's zone from intervals.icu, or null until it is known. */
let athleteTimeZone: string | null = null;

/** The last TZ value checked, so a call does not build an Intl formatter. */
let tzMemo: { raw: string; valid: boolean } | null = null;

/**
 * The zone TZ chooses, or null when it chooses none: unset, blank or exactly
 * UTC. An invalid TZ is never returned; checkConfig stops startup for one.
 */
function explicitTimeZone(): string | null {
  const raw = process.env.TZ?.trim() ?? "";
  if (raw === "" || raw === FOLLOW_ATHLETE_TZ) return null;
  if (tzMemo?.raw !== raw) tzMemo = { raw, valid: isValidTimeZone(raw) };
  return tzMemo.valid ? raw : null;
}

/** True when TZ chooses no zone, so the athlete's zone should apply. */
export function timeZoneNeedsAthlete(): boolean {
  return explicitTimeZone() === null;
}

/**
 * Stores the athlete's zone from intervals.icu. Returns false, and keeps the
 * current state, for a zone Intl does not know. null clears the state (a test
 * seam). The zone is stored trimmed, as given, not canonicalised.
 */
export function setAthleteTimeZone(zone: string | null): boolean {
  if (zone === null) {
    athleteTimeZone = null;
    return true;
  }
  const trimmed = zone.trim();
  if (!isValidTimeZone(trimmed)) return false;
  athleteTimeZone = trimmed;
  return true;
}

/**
 * The process zone, or UTC when Intl cannot name a usable one. Node reports
 * undefined for a blank or invalid TZ, and `Etc/Unknown` (which Intl then
 * rejects) for an empty one. Bun reports UTC.
 */
function processTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/**
 * The zone for local dates and where it came from: TZ when it chooses a
 * zone, else the athlete's intervals.icu zone, else the process zone.
 */
export function timeZoneSetting(): TimeZoneSetting {
  const env = explicitTimeZone();
  if (env) return { zone: env, source: "env" };
  if (athleteTimeZone)
    return { zone: athleteTimeZone, source: "intervals.icu" };
  return { zone: processTimeZone(), source: "fallback" };
}

/**
 * The one home for the IANA zone every local date uses ("today", default
 * date windows, the server instructions). See {@link timeZoneSetting}.
 */
export function getTimeZone(): string {
  return timeZoneSetting().zone;
}

export function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}`;
}

/**
 * A value for a message, quoted and cut to 64 characters. Never use it for
 * the API key or the auth token.
 */
function quoteValue(raw: string): string {
  const cut = raw.slice(0, MAX_QUOTED_CHARS);
  return `${JSON.stringify(cut)}${raw.length > MAX_QUOTED_CHARS ? "…" : ""}`;
}

/** The port, DEFAULT_PORT for a blank or unset value, or null when invalid. */
function parsePort(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (!value) return DEFAULT_PORT;
  if (!PORT_RE.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

function portMessage(raw: string): string {
  return `PORT is ${quoteValue(raw)}. It must be a whole number from 1 to 65535; leave it unset for ${DEFAULT_PORT}.`;
}

/**
 * The port to listen on. Throws on a value checkConfig rejects, so it can
 * never return 0, which Bun treats as "pick a random port".
 */
export function getPort(): number {
  const port = parsePort(process.env.PORT);
  if (port === null) throw new Error(portMessage(process.env.PORT ?? ""));
  return port;
}

export interface ConfigCheck {
  errors: string[];
  warnings: string[];
}

/**
 * Checks every variable at once, so an operator sees all problems in one
 * start. An error stops startup; a warning only logs. No message contains
 * the API key or the auth token.
 */
export function checkConfig(): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!apiKeyConfigured()) errors.push(new MissingApiKeyError().message);

  const tz = process.env.TZ?.trim();
  if (tz && !isValidTimeZone(tz)) {
    errors.push(
      `TZ is ${quoteValue(tz)}, which is not a time zone this server knows. Use an IANA name such as Australia/Sydney, or leave TZ unset to use the athlete's time zone from intervals.icu.`,
    );
  }

  if (parsePort(process.env.PORT) === null) {
    errors.push(portMessage(process.env.PORT ?? ""));
  }

  const athleteId = process.env.INTERVALS_ATHLETE_ID?.trim();
  if (athleteId && !ATHLETE_ID_RE.test(athleteId)) {
    errors.push(
      `INTERVALS_ATHLETE_ID is ${quoteValue(athleteId)}. It must be 0 (the API key's own athlete) or an athlete id such as i12345.`,
    );
  }

  const token = process.env.MCP_AUTH_TOKEN;
  if (token && token.trim() !== token) {
    errors.push(
      "MCP_AUTH_TOKEN starts or ends with whitespace. No client can send that in an Authorization header, so every /mcp request would get 401; remove the whitespace.",
    );
  } else if (token && token.length < MIN_AUTH_TOKEN_LENGTH) {
    warnings.push(
      `MCP_AUTH_TOKEN is ${token.length} characters. Use at least ${MIN_AUTH_TOKEN_LENGTH}, for example from openssl rand -hex 32.`,
    );
  }

  return { errors, warnings };
}
