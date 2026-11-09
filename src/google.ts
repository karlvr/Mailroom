import type { Env } from "./env";
import {
  type Account,
  type GoogleConfig,
  getGoogleConfig,
  getRefreshToken,
  setAccountStatus,
} from "./db";
import { b64url, fromB64url } from "./crypto";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const callbackUrl = (origin: string) => `${origin}/google/callback`;

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export function authorizeUrl(
  cfg: GoogleConfig,
  origin: string,
  opts: { state: string; challenge: string; mailbox: boolean; loginHint?: string },
): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    scope: opts.mailbox ? `openid email ${GMAIL_SCOPE}` : "openid email",
  });
  if (opts.mailbox) {
    // offline + consent guarantees a refresh token every time an account is (re)linked
    p.set("access_type", "offline");
    p.set("prompt", "consent select_account");
  } else {
    p.set("prompt", "select_account");
  }
  if (opts.loginHint) p.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${p}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(
  cfg: GoogleConfig,
  origin: string,
  code: string,
  verifier: string,
): Promise<{ sub: string; email: string; emailVerified: boolean; refreshToken?: string; scopes: string[] }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: callbackUrl(origin),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.id_token) {
    throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  // The ID token came straight from Google's token endpoint over TLS, so its payload can be trusted
  // without re-verifying the signature (OpenID Connect Core 3.1.3.7).
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(data.id_token.split(".")[1]))) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    aud: string;
  };
  if (claims.aud !== cfg.clientId) throw new Error("The audience of the ID token does not match the Client ID.");
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    refreshToken: data.refresh_token,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
  };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

/** Thrown when an account's Google access is gone and it must be re-linked. */
export class AccountNeedsRelink extends Error {}

// Access tokens live for an hour; keep them in isolate memory only.
const accessTokens = new Map<string, { token: string; expires: number }>();

async function accessToken(env: Env, account: Account): Promise<string> {
  const hit = accessTokens.get(account.id);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;

  const cfg = await getGoogleConfig(env);
  if (!cfg) throw new Error("Google is not configured. Complete the setup page first.");
  let refresh: string;
  try {
    refresh = await getRefreshToken(env, account);
  } catch {
    await setAccountStatus(env, account.id, "relink", "The stored Google token cannot be decrypted. Possibly ADMIN_PASSWORD changed.");
    throw new AccountNeedsRelink(
      `The stored Google token for ${account.email} cannot be decrypted. The user must re-link this mailbox on ${appUrlHint}.`,
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      await setAccountStatus(env, account.id, "relink", data.error_description ?? "The Google access was revoked, or it expired.");
      throw new AccountNeedsRelink(
        `The Google access for ${account.email} was revoked, or it expired. The user must re-link this mailbox on ${appUrlHint}.`,
      );
    }
    throw new Error(`Could not refresh the Google access for ${account.email}: ${data.error_description || data.error || res.status}`);
  }
  if (account.status !== "ok") await setAccountStatus(env, account.id, "ok", null);
  accessTokens.set(account.id, { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

const appUrlHint = "the Mailroom web page";

export class GmailError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Call the Gmail API for one linked account. `path` is relative to /gmail/v1/users/me. */
export async function gmail<T>(
  env: Env,
  account: Account,
  path: string,
  init: { method?: string; query?: Record<string, string | string[] | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(env, account);
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      accessTokens.delete(account.id);
      continue;
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new GmailError(res.status, data.error?.message ?? `Gmail API error ${res.status}`);
    return data as T;
  }
  throw new GmailError(401, "Gmail rejected the access token");
}
