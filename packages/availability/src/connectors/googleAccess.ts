import {
  GoogleApiError,
  type GoogleConnectionRow,
  type GoogleTokenSource,
  hasGoogleScope,
  SkipWrite,
} from "@steward/core";

export const CONNECT_GOOGLE = "Google isn't connected — run /ooo google";
export const RECONNECT_GOOGLE = "Reconnect Google — run /ooo google";
export const GOOGLE_PERMISSION = "Steward wasn't given that permission — run /ooo google";

/** For a write: a usable access token, or a SkipWrite that says what the person should do. */
export async function googleAccessOrSkip(
  tokens: GoogleTokenSource,
  personId: string,
  scope: string,
): Promise<{ accessToken: string; connection: GoogleConnectionRow }> {
  const access = await tokens.accessFor(personId);
  if (!access.ok) {
    throw new SkipWrite(access.reason === "reconnect" ? RECONNECT_GOOGLE : CONNECT_GOOGLE);
  }
  if (!hasGoogleScope(access.connection, scope)) throw new SkipWrite(GOOGLE_PERMISSION);
  return { accessToken: access.accessToken, connection: access.connection };
}

/** Runs `call`; if Google answers 401, forgets the stored access token, then rethrows. */
export async function expiringOn401<T>(
  tokens: GoogleTokenSource,
  personId: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 401) await tokens.expire(personId);
    throw error;
  }
}
