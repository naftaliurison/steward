import { slackSignature, timingSafeEqual } from "@steward/core";

export const GOOGLE_STATE_MAX_AGE_SECONDS = 600;

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/** The `google:` prefix keeps a Slack-install state from passing as a Google state, and back. */
async function mac(secret: string, issuedAtSeconds: string, personId: string): Promise<string> {
  const signature = await slackSignature(
    secret,
    issuedAtSeconds,
    `google:${issuedAtSeconds}:${personId}`,
  );
  return signature.slice(3);
}

/** A signed, short-lived ticket that says which Slack person is connecting Google. */
export async function signGoogleState(
  secret: string,
  personId: string,
  issuedAtSeconds: number,
): Promise<string> {
  const issued = String(issuedAtSeconds);
  return `${issued}.${toBase64Url(personId)}.${await mac(secret, issued, personId)}`;
}

/** The person id if the ticket is genuine and not older than ten minutes; otherwise null. */
export async function verifyGoogleState(
  secret: string,
  state: string,
  nowSeconds: number,
): Promise<string | null> {
  try {
    const parts = state.split(".");
    if (parts.length !== 3) return null;
    const [ts, encoded, signature] = parts as [string, string, string];
    if (!/^\d+$/.test(ts)) return null;
    const issued = Number(ts);
    if (
      !Number.isFinite(issued) ||
      nowSeconds - issued > GOOGLE_STATE_MAX_AGE_SECONDS ||
      issued > nowSeconds + 60
    )
      return null;
    const personId = fromBase64Url(encoded);
    if (personId === null) return null;
    return timingSafeEqual(await mac(secret, ts, personId), signature) ? personId : null;
  } catch {
    return null;
  }
}
