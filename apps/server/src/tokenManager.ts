import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TIMEOUT_MS, isAbortError, stravaApi } from "./fetchClient";

// Calculate paths — monorepo root is 3 levels up from apps/server/src/
const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..");

// Token file location - uses /app/data in Docker (mounted volume) or ./data locally
const dataDir = process.env.TOKEN_DATA_DIR || path.join(projectRoot, "data");
const tokenFilePath = path.join(dataDir, "tokens.json");

// Buffer time before expiration to trigger refresh (5 minutes)
const EXPIRATION_BUFFER_SECONDS = 5 * 60;

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in seconds
  athlete_id?: number; // Athlete ID from OAuth response
}

export interface TokenStatus {
  authenticated: boolean;
  expires_at?: string; // ISO 8601 date string
  expires_in_minutes?: number;
  athlete_id?: number;
  auth_url?: string;
}

/**
 * The refresh token has been revoked (the athlete deauthorized the app) or is
 * otherwise permanently invalid. Retrying the refresh can never succeed; the
 * only recovery is re-authorization via /auth/start. Stored token state has
 * already been cleared by the time this is thrown.
 */
export class TokenRevokedError extends Error {
  constructor() {
    super(
      "Strava authorization has been revoked or is no longer valid. " +
        "Stored tokens have been cleared. Re-authorize by visiting /auth/start, then retry.",
    );
    this.name = "TokenRevokedError";
  }
}

/**
 * No Strava credentials are available at all — nothing stored, nothing in the
 * environment. Distinct from {@link TokenRevokedError}, which means we *had*
 * credentials and Strava rejected them. Both recover the same way, so both
 * carry an actionable message naming /auth/start.
 */
export class NoTokenError extends Error {
  constructor() {
    super(
      "Not connected to Strava. No access token is available. " +
        "Authorize the server by visiting /auth/start, then retry.",
    );
    this.name = "NoTokenError";
  }
}

/**
 * Detects Strava's revoked / invalid-grant response to a refresh_token
 * exchange, distinct from transient failures (5xx, network). Strava answers a
 * dead refresh token with HTTP 400 and an errors array naming the
 * refresh_token field (`{"resource":"RefreshToken","field":"refresh_token",
 * "code":"invalid"}`); standard OAuth servers use `{"error":"invalid_grant"}`.
 */
function isRevokedGrantResponse(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 401) {
    return false;
  }
  if (bodyText.includes("invalid_grant")) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const errors = (parsed as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      return errors.some(
        (e: unknown) =>
          typeof e === "object" &&
          e !== null &&
          ((e as { field?: unknown }).field === "refresh_token" ||
            (e as { resource?: unknown }).resource === "RefreshToken"),
      );
    }
  } catch {
    // Not JSON; fall through
  }
  return false;
}

/** Tunables for the raw OAuth token exchanges; tests inject an instant sleep. */
export interface OAuthRequestOptions {
  /** Per-attempt timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Retry attempts beyond the initial POST, 5xx only (default 2). */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms (default 500). */
  baseDelayMs?: number;
  /** Sleep implementation; injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/** The parts of an OAuth response the callers below need. */
interface OAuthResult {
  ok: boolean;
  status: number;
  bodyText: string;
}

/**
 * POSTs to Strava's `/oauth/token` with a timeout and a 5xx-only retry.
 *
 * These two exchanges cannot go through {@link FetchClient} — it deliberately
 * never retries writes, and a token exchange is a POST. The narrower rule here
 * is deliberate: a 5xx means Strava failed the request outright, so the refresh
 * token was not rotated and re-sending it is safe. A timeout or network fault
 * is *not* retried, because the exchange may have succeeded server-side and
 * rotated the refresh token — a second POST would then send a token Strava has
 * already invalidated and lock the server out.
 */
async function postOAuthToken(
  body: Record<string, string>,
  options: OAuthRequestOptions = {},
): Promise<OAuthResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(
          `Strava OAuth token exchange timed out after ${timeoutMs}ms.`,
        );
      }
      throw error;
    }

    const bodyText = await response.text();
    if (
      !response.ok &&
      response.status >= 500 &&
      response.status < 600 &&
      attempt < maxRetries
    ) {
      await sleep(Math.round(Math.random() * baseDelayMs * 2 ** attempt));
      attempt += 1;
      continue;
    }

    return { ok: response.ok, status: response.status, bodyText };
  }
}

/**
 * Ensures the data directory exists
 */
async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch {
    // Directory might already exist, that's fine
  }
}

/**
 * Loads tokens from persistent storage (tokens.json) or falls back to environment variables.
 * @returns TokenData if tokens are available, null otherwise
 */
async function loadTokens(): Promise<TokenData | null> {
  // First, try to load from tokens.json
  try {
    const content = await fs.readFile(tokenFilePath, "utf-8");
    const data = JSON.parse(content) as TokenData;

    if (data.access_token && data.refresh_token && data.expires_at) {
      console.error(`[TokenManager] Loaded tokens from ${tokenFilePath}`);
      console.error(
        `[TokenManager] Token expires: ${new Date(
          data.expires_at * 1000,
        ).toLocaleString()}`,
      );

      // Update process.env so the rest of the app can use them
      process.env.STRAVA_ACCESS_TOKEN = data.access_token;
      process.env.STRAVA_REFRESH_TOKEN = data.refresh_token;

      return data;
    }
  } catch {
    // File doesn't exist or is invalid, fall back to env vars
    console.error(
      "[TokenManager] No tokens.json found, falling back to environment variables",
    );
  }

  // Fall back to environment variables
  const accessToken = process.env.STRAVA_ACCESS_TOKEN;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;

  if (accessToken && refreshToken) {
    console.error("[TokenManager] Using tokens from environment variables");
    // We don't know the expiration time from env vars, so assume expired to trigger refresh
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: 0, // Force refresh on first use
    };
  }

  console.error("[TokenManager] No tokens available");
  return null;
}

/**
 * Saves tokens to persistent storage (tokens.json)
 */
export async function saveTokens(tokens: TokenData): Promise<void> {
  await ensureDataDir();

  try {
    // Write to a temp file then atomically rename over the target. A plain
    // writeFile leaves a window where a crash mid-write corrupts tokens.json;
    // rename is atomic on the same filesystem, so readers see either the old
    // file or the fully-written new one, never a partial.
    const tempFilePath = `${tokenFilePath}.tmp`;
    // 0600: the file holds live OAuth credentials, so keep it owner-only.
    // The mode applies at creation and survives the rename.
    await fs.writeFile(tempFilePath, JSON.stringify(tokens, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tempFilePath, tokenFilePath);
    // Both OAuth exchanges land here, so this is where the in-memory copy that
    // getStravaToken serves stays in step with what is on disk.
    cachedTokens = tokens;
    console.error(`[TokenManager] Tokens saved to ${tokenFilePath}`);
    console.error(
      `[TokenManager] New expiration: ${new Date(
        tokens.expires_at * 1000,
      ).toLocaleString()}`,
    );
  } catch (error) {
    console.error("[TokenManager] Failed to save tokens:", error);
    throw error;
  }
}

/**
 * Clears all stored token state after a confirmed revocation: removes
 * tokens.json and drops the env fallbacks. Without this, every subsequent
 * request would reload the dead refresh token and retry a doomed exchange.
 */
async function clearTokens(): Promise<void> {
  cachedTokens = null;
  try {
    await fs.rm(tokenFilePath, { force: true });
  } catch (error) {
    console.error("[TokenManager] Failed to remove token file:", error);
  }
  delete process.env.STRAVA_ACCESS_TOKEN;
  delete process.env.STRAVA_REFRESH_TOKEN;
  console.error(
    "[TokenManager] Cleared stored tokens. Re-authorize at /auth/start.",
  );
}

/**
 * Checks if the token is expired or will expire soon
 */
function isTokenExpired(tokens: TokenData): boolean {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = tokens.expires_at;
  const isExpired = now >= expiresAt - EXPIRATION_BUFFER_SECONDS;

  if (isExpired) {
    const expiredAgo = now - expiresAt;
    if (expiredAgo > 0) {
      console.error(
        `[TokenManager] Token expired ${Math.floor(
          expiredAgo / 60,
        )} minutes ago`,
      );
    } else {
      console.error(
        `[TokenManager] Token expires in ${Math.floor(
          -expiredAgo / 60,
        )} minutes (within buffer)`,
      );
    }
  }

  return isExpired;
}

/**
 * Refreshes the access token using the refresh token
 */
async function refreshTokens(
  tokens: TokenData,
  options: OAuthRequestOptions = {},
): Promise<TokenData> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in environment",
    );
  }

  console.error("[TokenManager] Refreshing access token...");

  try {
    const response = await postOAuthToken(
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      },
      options,
    );

    if (!response.ok) {
      const { bodyText } = response;
      if (isRevokedGrantResponse(response.status, bodyText)) {
        console.error(
          `[TokenManager] Refresh token revoked or invalid (HTTP ${response.status}): ${bodyText}`,
        );
        await clearTokens();
        throw new TokenRevokedError();
      }
      throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    const data = JSON.parse(response.bodyText);

    const newTokens: TokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      // Strava's refresh_token grant response does not echo the athlete, so
      // carry the existing athlete_id forward (falling back to one if present).
      athlete_id: data.athlete?.id ?? tokens.athlete_id,
    };

    // Update process.env for the rest of the app
    process.env.STRAVA_ACCESS_TOKEN = newTokens.access_token;
    process.env.STRAVA_REFRESH_TOKEN = newTokens.refresh_token;

    // Persist to file
    await saveTokens(newTokens);

    console.error("[TokenManager] Token refresh successful");
    return newTokens;
  } catch (error) {
    console.error("[TokenManager] Token refresh failed:", error);
    if (error instanceof TokenRevokedError) {
      throw error;
    }
    throw new Error(
      `Failed to refresh token: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Tracks an in-flight refresh so concurrent callers coalesce onto one exchange.
 *
 * Strava rotates the refresh token on every `/oauth/token` exchange and
 * invalidates the previous one. Two concurrent refreshes would each POST the
 * same refresh token; the first rotates it, the second then sends an
 * already-invalidated token and can fail — permanently locking the server out.
 * Coalescing guarantees exactly one exchange while a refresh is pending.
 */
let inFlightRefresh: Promise<TokenData> | null = null;

/**
 * Refreshes the access token, coalescing concurrent callers onto a single
 * in-flight exchange. Loads the current tokens (for the refresh token and
 * athlete_id), refreshes, persists, and updates process.env. This is the single
 * refresh path; both startup expiry checks and 401 recovery route through here.
 */
export async function refreshAccessToken(
  options: OAuthRequestOptions = {},
): Promise<TokenData> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    const tokens = await loadTokens();
    if (!tokens) {
      throw new Error(
        "No tokens available to refresh. Authenticate at /auth/start first.",
      );
    }
    return refreshTokens(tokens, options);
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

/**
 * The tokens most recently loaded or written, kept in memory so the common path
 * through {@link getStravaToken} — a valid token, once per tool call — costs no
 * filesystem read. Cleared on revocation; refreshed writes land here via
 * {@link saveTokens}, the single choke point both OAuth exchanges pass through.
 */
let cachedTokens: TokenData | null = null;

/**
 * Resolves the access token for an outbound Strava call, refreshing *before* it
 * expires rather than after a wasted 401.
 *
 * This is the single token entry point: tool handlers receive the resolved
 * token rather than reading `process.env.STRAVA_ACCESS_TOKEN` themselves, so
 * there is one expiry policy and one not-connected message across every tool.
 *
 * @throws {NoTokenError} when no credentials exist at all.
 * @throws {TokenRevokedError} when the stored refresh token is dead.
 */
export async function getStravaToken(): Promise<string> {
  let tokens = cachedTokens ?? (await loadTokens());

  if (!tokens) {
    throw new NoTokenError();
  }

  // Inside the expiry buffer, refresh now. refreshAccessToken coalesces
  // concurrent callers onto one exchange, so parallel tool calls at rollover
  // cost a single /oauth/token round-trip.
  if (isTokenExpired(tokens)) {
    tokens = await refreshAccessToken();
  }

  cachedTokens = tokens;
  return tokens.access_token;
}

/**
 * Ensures we have a valid (non-expired) access token.
 * Loads tokens, checks expiration, and refreshes if needed.
 * This should be called on server startup.
 */
export async function ensureValidToken(): Promise<void> {
  console.error("[TokenManager] Checking token validity...");

  const tokens = await loadTokens();

  if (!tokens) {
    console.error(
      "[TokenManager] No tokens available. Visit /auth/start to authenticate.",
    );
    return; // Don't throw - allow server to start without tokens for OAuth flow
  }

  if (isTokenExpired(tokens)) {
    console.error(
      "[TokenManager] Token expired or expiring soon, refreshing...",
    );
    try {
      await refreshAccessToken();
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        // Don't crash startup on a revoked token: the server must come up so
        // /auth/start can be used to re-authorize. Tokens are already cleared.
        console.error(`[TokenManager] ${error.message}`);
        return;
      }
      throw error;
    }
  } else {
    const expiresIn = tokens.expires_at - Math.floor(Date.now() / 1000);
    console.error(
      `[TokenManager] Token is valid for ${Math.floor(
        expiresIn / 60,
      )} more minutes`,
    );
  }
}

/**
 * Gets the current token status for /auth/status and the authed half of
 * /health.
 *
 * Served from the in-memory copy whenever one exists. Both endpoints are
 * polled continuously (the container HEALTHCHECK, operator dashboards), and
 * reading tokens.json on every poll re-emitted the "Loaded tokens" lines until
 * they buried the real telemetry in `docker compose logs`. The copy is the
 * token set the running server actually uses: refreshes rotate it and both
 * OAuth exchanges write it via {@link saveTokens}, so the answer here matches
 * what tool calls send. The trade-off is that a tokens.json replaced by hand
 * underneath a running process is not picked up until restart, exactly as it
 * is not picked up by tool calls.
 *
 * "No tokens" is never cached: an unauthenticated poll consults disk every
 * time, so a freshly written tokens.json shows up on the next poll.
 */
export async function getTokenStatus(): Promise<TokenStatus> {
  const tokens = cachedTokens ?? (await loadTokens());

  if (!tokens?.access_token) {
    return {
      authenticated: false,
      auth_url: "/auth/start",
    };
  }

  // Mirror getStravaToken: keep what disk handed us so the next poll is
  // answered from memory.
  cachedTokens = tokens;

  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = tokens.expires_at - now;
  const expiresInMinutes = Math.floor(expiresInSeconds / 60);

  return {
    authenticated: true,
    expires_at: new Date(tokens.expires_at * 1000).toISOString(),
    expires_in_minutes: expiresInMinutes,
    athlete_id: tokens.athlete_id,
  };
}

/**
 * Exchanges an OAuth authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  options: OAuthRequestOptions = {},
): Promise<TokenData> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in environment",
    );
  }

  console.error("[TokenManager] Exchanging authorization code for tokens...");

  const response = await postOAuthToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: "authorization_code",
    },
    options,
  );

  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed: HTTP ${response.status}: ${response.bodyText}`,
    );
  }

  const data = JSON.parse(response.bodyText);

  const tokens: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete_id: data.athlete?.id,
  };

  // Update process.env for the rest of the app
  process.env.STRAVA_ACCESS_TOKEN = tokens.access_token;
  process.env.STRAVA_REFRESH_TOKEN = tokens.refresh_token;

  // Persist to file
  await saveTokens(tokens);

  // The athlete who just authorized may not be the one whose responses are
  // cached. The response cache keys on the bare URL, and `/athlete` and
  // `/athlete/activities` are athlete-scoped behind athlete-independent URLs,
  // so without this the next few minutes serve the previous athlete's profile
  // — and the stats get-athlete-stats resolves from that id — to the new one.
  stravaApi.clearResponseCache();

  console.error("[TokenManager] OAuth token exchange successful");
  return tokens;
}
