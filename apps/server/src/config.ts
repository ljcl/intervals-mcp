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

/** IANA zone for local-date maths; falls back to the process zone. */
export function getTimeZone(): string {
  return (
    process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
  );
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
      `TZ is ${quoteValue(tz)}, which is not a time zone this server knows. Use an IANA name such as Australia/Sydney, or leave TZ unset.`,
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
