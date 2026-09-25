/**
 * Seal secrets at rest (a connected account's refresh token) with AES-GCM
 * under SOURCE_TOKEN_KEY. A copy of the Durable Object's storage alone is not
 * enough to read someone's mail.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const raw = env.SOURCE_TOKEN_KEY;
  if (!raw) throw new Error("SOURCE_TOKEN_KEY is not set");
  const bytes = unb64(raw.trim());
  if (bytes.byteLength !== 32) throw new Error("SOURCE_TOKEN_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** "v1.<iv>.<ciphertext>", base64. */
export async function seal(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function unseal(env: Env, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unrecognized sealed value");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(ct));
  return dec.decode(plain);
}
