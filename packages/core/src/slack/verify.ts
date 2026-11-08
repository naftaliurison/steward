const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison; false for different lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function slackSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  return `v0=${toHex(mac)}`;
}

const MAX_SKEW_SECONDS = 300;

export async function verifySlackSignature(args: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  nowSeconds: number;
}): Promise<boolean> {
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts) || Math.abs(args.nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  const expected = await slackSignature(args.secret, args.timestamp, args.body);
  return timingSafeEqual(expected, args.signature);
}
