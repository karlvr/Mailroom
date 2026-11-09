// Encryption for secrets at rest (Google client secret, refresh tokens).
// The key is derived from ADMIN_PASSWORD with a per-deployment random salt kept in D1,
// so a copy of the database alone can't be decrypted.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

let cached: { password: string; salt: string; key: CryptoKey } | undefined;

export async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  if (cached && cached.password === password && cached.salt === salt) return cached.key;
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64url(salt), iterations: 100_000 },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  cached = { password, salt, key };
  return key;
}

/** Returns "v1.<iv>.<ciphertext>" */
export async function encrypt(key: CryptoKey, plaintext: string, aad = ""): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decrypt(key: CryptoKey, payload: string, aad = ""): Promise<string> {
  const [v, iv, ct] = payload.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unrecognised ciphertext");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(aad) },
    key,
    fromB64url(ct),
  );
  return dec.decode(pt);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
