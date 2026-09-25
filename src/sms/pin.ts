/**
 * The texting PIN: 4 digits that open any link Busta texts. Stored only as a
 * PBKDF2-SHA256 hash with its own salt. Short PINs are weak against an
 * offline guess, so the real protection is that each link allows 5 tries.
 */
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const validPin = (pin: string) => /^\d{4}$/.test(pin);

async function derive(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256));
}

/** "v1.<salt>.<hash>" */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `v1.${b64(salt)}.${b64(await derive(pin, salt))}`;
}

export async function checkPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored || !validPin(pin)) return false;
  const [v, salt, hash] = stored.split(".");
  if (v !== "v1" || !salt || !hash) return false;
  const got = await derive(pin, unb64(salt));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}
