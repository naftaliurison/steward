import { open, seal } from "../crypto/seal";
import type { Db } from "../db/client";
import { getGoogleConnection, setGoogleAccessToken, setGoogleHealth } from "../db/repo";
import type { GoogleConnectionRow } from "../db/schema";
import { GoogleApiError, type GoogleClient } from "./client";

export type GoogleAccess =
  | { ok: true; accessToken: string; connection: GoogleConnectionRow }
  | { ok: false; reason: "not_connected" | "reconnect" };

/** A stored access token with less than this left is refreshed instead of used. */
export const ACCESS_TOKEN_MARGIN_MS = 60_000;

/** The one place that hands out a valid Google access token for a person, refreshing it when needed. */
export class GoogleTokenSource {
  constructor(
    private readonly deps: {
      db: Db;
      google: GoogleClient;
      tokenKey: string;
      clientId: string;
      clientSecret: string;
      now: () => number;
    },
  ) {}

  /** A usable access token for this person, refreshed if needed. */
  async accessFor(personId: string): Promise<GoogleAccess> {
    const { db, google, tokenKey, clientId, clientSecret, now } = this.deps;
    const connection = await getGoogleConnection(db, personId);
    if (!connection) return { ok: false, reason: "not_connected" };
    if (connection.health === "revoked") return { ok: false, reason: "reconnect" };

    if (
      connection.accessTokenSealed !== null &&
      connection.accessExpiresAt !== null &&
      connection.accessExpiresAt - now() > ACCESS_TOKEN_MARGIN_MS
    ) {
      return {
        ok: true,
        accessToken: await open(tokenKey, connection.accessTokenSealed),
        connection,
      };
    }

    const refreshToken = await open(tokenKey, connection.refreshTokenSealed);
    let fresh: { accessToken: string; expiresInSeconds: number };
    try {
      fresh = await google.refreshAccessToken({ clientId, clientSecret, refreshToken });
    } catch (error) {
      if (error instanceof GoogleApiError && error.code === "invalid_grant") {
        await setGoogleHealth(db, personId, "revoked", now());
        return { ok: false, reason: "reconnect" };
      }
      throw error;
    }
    await setGoogleAccessToken(db, personId, {
      accessTokenSealed: await seal(tokenKey, fresh.accessToken),
      accessExpiresAt: now() + fresh.expiresInSeconds * 1000,
      updatedAt: now(),
    });
    return { ok: true, accessToken: fresh.accessToken, connection };
  }

  /** Forget the stored access token so the next call refreshes (used after Google answers 401). */
  async expire(personId: string): Promise<void> {
    await setGoogleAccessToken(this.deps.db, personId, {
      accessTokenSealed: null,
      accessExpiresAt: null,
      updatedAt: this.deps.now(),
    });
  }
}
