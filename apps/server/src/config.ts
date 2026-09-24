/**
 * intervals.icu connection settings. The only module that reads the
 * INTERVALS_* env vars, so tools and the HTTP layer never touch process.env
 * for credentials (envScaffolding.test.ts enforces this).
 *
 * Auth is a personal API key sent as HTTP Basic with the literal username
 * `API_KEY`. Athlete id `0` means "the key's own athlete".
 */

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
