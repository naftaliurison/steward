const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function importKey(keyB64: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.byteLength !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

export function newKeyB64(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function seal(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return b64encode(out);
}

export async function open(keyB64: string, sealed: string): Promise<string> {
  const key = await importKey(keyB64, "decrypt");
  const bytes = b64decode(sealed);
  const iv = bytes.slice(0, IV_BYTES);
  const ciphertext = bytes.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return decoder.decode(plaintext);
}
