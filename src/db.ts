import type { Env } from "./env";
import { decrypt, deriveKey, encrypt, randomToken } from "./crypto";

// The schema is in migrations/. `npm run deploy` and `npm run dev` apply it before the Worker runs.

// ---------- config ----------

export async function getConfig(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export async function dataKey(env: Env): Promise<CryptoKey> {
  if (!env.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD secret is not set");
  let salt = await getConfig(env, "kdf_salt");
  if (!salt) {
    salt = randomToken(16);
    await env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('kdf_salt', ?)").bind(salt).run();
    salt = (await getConfig(env, "kdf_salt"))!;
  }
  return deriveKey(env.ADMIN_PASSWORD, salt);
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export async function getGoogleConfig(env: Env): Promise<GoogleConfig | null> {
  const clientId = await getConfig(env, "google_client_id");
  const secret = await getConfig(env, "google_client_secret");
  if (!clientId || !secret) return null;
  try {
    return { clientId, clientSecret: await decrypt(await dataKey(env), secret, "google_client_secret") };
  } catch {
    // ADMIN_PASSWORD changed since the secret was saved
    return null;
  }
}

export async function saveGoogleConfig(env: Env, cfg: GoogleConfig): Promise<void> {
  await setConfig(env, "google_client_id", cfg.clientId);
  await setConfig(env, "google_client_secret", await encrypt(await dataKey(env), cfg.clientSecret, "google_client_secret"));
}

/** Who may sign in: exact addresses or "@domain.com" entries, one per line. */
export async function getAllowlist(env: Env): Promise<string[]> {
  const raw = (await getConfig(env, "allowed_emails")) ?? "";
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(allowlist: string[], email: string): boolean {
  const e = email.toLowerCase();
  return allowlist.some((entry) => (entry.startsWith("@") ? e.endsWith(entry) : e === entry));
}

// ---------- users ----------

export async function upsertUser(env: Env, id: string, email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, last_login_at = excluded.last_login_at`,
  )
    .bind(id, email, now, now)
    .run();
}

// ---------- accounts ----------

export interface Account {
  id: string;
  user_id: string;
  email: string;
  name: string;
  context: string;
  status: string;
  status_detail: string | null;
  /** 1 when the owner allows Claude to send email from this mailbox, otherwise 0. */
  allow_send: number;
  created_at: number;
  updated_at: number;
}

/** The settings of a linked mailbox that its owner controls. */
export interface AccountDetails {
  /** A short name for the mailbox. */
  name: string;
  /** Notes for Claude about the purpose of the mailbox and how to treat it. */
  context: string;
  /** True when Claude may send email from this mailbox. */
  allowSend: boolean;
}

const ACCOUNT_COLS = "id, user_id, email, name, context, status, status_detail, allow_send, created_at, updated_at";

export async function listAccounts(env: Env, userId: string): Promise<Account[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE user_id = ? ORDER BY name COLLATE NOCASE, email`,
  )
    .bind(userId)
    .all<Account>();
  return results;
}

/** Find by email or id, scoped to the user. */
export async function findAccount(env: Env, userId: string, ref: string): Promise<Account | null> {
  return env.DB.prepare(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE user_id = ? AND (lower(email) = lower(?) OR id = ?)`,
  )
    .bind(userId, ref, ref)
    .first<Account>();
}

export async function saveLinkedAccount(env: Env, userId: string, email: string, refreshToken: string): Promise<void> {
  const now = Date.now();
  const id = randomToken(9);
  const enc = await encrypt(await dataKey(env), refreshToken, `refresh:${userId}:${email.toLowerCase()}`);
  await env.DB.prepare(
    `INSERT INTO accounts (id, user_id, email, name, context, refresh_token, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', ?, 'ok', ?, ?)
     ON CONFLICT(user_id, email) DO UPDATE SET
       refresh_token = excluded.refresh_token, status = 'ok', status_detail = NULL, updated_at = excluded.updated_at`,
  )
    .bind(id, userId, email, enc, now, now)
    .run();
}

export async function getRefreshToken(env: Env, account: Account): Promise<string> {
  const row = await env.DB.prepare("SELECT refresh_token FROM accounts WHERE id = ?")
    .bind(account.id)
    .first<{ refresh_token: string }>();
  if (!row) throw new Error("Account not found");
  return decrypt(await dataKey(env), row.refresh_token, `refresh:${account.user_id}:${account.email.toLowerCase()}`);
}

export async function updateAccountDetails(
  env: Env,
  userId: string,
  id: string,
  details: AccountDetails,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE accounts SET name = ?, context = ?, allow_send = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(details.name.slice(0, 100), details.context.slice(0, 8000), details.allowSend ? 1 : 0, Date.now(), id, userId)
    .run();
}

export async function setAccountStatus(env: Env, id: string, status: string, detail: string | null): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?")
    .bind(status, detail, Date.now(), id)
    .run();
}

export async function deleteAccount(env: Env, userId: string, id: string): Promise<Account | null> {
  const acct = await env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<Account>();
  if (acct) await env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return acct;
}
