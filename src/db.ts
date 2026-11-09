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
  if (!env.ADMIN_PASSWORD) throw new Error("The ADMIN_PASSWORD secret is not set.");
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

/**
 * Returns the version of the setup steps that the admin last completed. A deployment that the admin
 * configured before Mailroom recorded the version has version 1. A deployment that the admin did not
 * configure yet has version 0.
 */
export async function getSetupVersion(env: Env): Promise<number> {
  const version = await getConfig(env, "setup_version");
  if (version) return Number(version);
  return (await getConfig(env, "google_client_id")) ? 1 : 0;
}

/** Records that the admin completed the setup steps of `version`. */
export async function setSetupVersion(env: Env, version: number): Promise<void> {
  await setConfig(env, "setup_version", String(version));
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
  /** 1 when the owner allows Claude to send calendar invitations from this account, otherwise 0. */
  allow_invite: number;
  /** 1 when the owner allows Claude to reply to calendar invitations for this account, otherwise 0. */
  allow_reply: number;
  /** The Google permissions that the stored refresh token grants, separated by spaces. Null for an account linked before Mailroom recorded them. */
  scopes: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * The actions of a linked account that notify other people. The owner allows each one separately,
 * and each one is off until the owner allows it.
 */
export interface AccountPermissions {
  /** True when Claude may send email from this mailbox. */
  sendEmail: boolean;
  /** True when Claude may invite guests to events, and change or delete events that have other guests. */
  sendInvitations: boolean;
  /** True when Claude may accept, decline or tentatively accept invitations. */
  replyToInvitations: boolean;
}

/** The label of the setting that controls each permission, as the owner sees it on the web page. */
export const PERMISSION_LABELS: Record<keyof AccountPermissions, string> = {
  sendEmail: "Allow sending email",
  sendInvitations: "Allow sending calendar invitations",
  replyToInvitations: "Allow replies to invitations",
};

/** Returns the permissions that the owner gave to an account. */
export function accountPermissions(a: Account): AccountPermissions {
  return { sendEmail: a.allow_send === 1, sendInvitations: a.allow_invite === 1, replyToInvitations: a.allow_reply === 1 };
}

/** Returns the Google permissions that the stored refresh token of the account grants. */
export function grantedScopes(a: Account): string[] {
  return (a.scopes ?? "").split(" ").filter(Boolean);
}

/** The settings of a linked mailbox that its owner controls. */
export interface AccountDetails {
  /** A short name for the mailbox. */
  name: string;
  /** Notes for Claude about the purpose of the mailbox and how to treat it. */
  context: string;
  permissions: AccountPermissions;
}

/** A Google account that the owner linked, with the access that Google granted. */
export interface LinkedGoogleAccount {
  email: string;
  refreshToken: string;
  /** The Google permissions that the refresh token grants. */
  scopes: string[];
}

const ACCOUNT_COLS =
  "id, user_id, email, name, context, status, status_detail, allow_send, allow_invite, allow_reply, scopes, created_at, updated_at";

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

export async function saveLinkedAccount(env: Env, userId: string, link: LinkedGoogleAccount): Promise<void> {
  const now = Date.now();
  const id = randomToken(9);
  const enc = await encrypt(await dataKey(env), link.refreshToken, `refresh:${userId}:${link.email.toLowerCase()}`);
  await env.DB.prepare(
    `INSERT INTO accounts (id, user_id, email, name, context, refresh_token, scopes, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', ?, ?, 'ok', ?, ?)
     ON CONFLICT(user_id, email) DO UPDATE SET
       refresh_token = excluded.refresh_token, scopes = excluded.scopes, status = 'ok', status_detail = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(id, userId, link.email, enc, link.scopes.join(" "), now, now)
    .run();
}

export async function getRefreshToken(env: Env, account: Account): Promise<string> {
  const row = await env.DB.prepare("SELECT refresh_token FROM accounts WHERE id = ?")
    .bind(account.id)
    .first<{ refresh_token: string }>();
  if (!row) throw new Error("The account does not exist.");
  return decrypt(await dataKey(env), row.refresh_token, `refresh:${account.user_id}:${account.email.toLowerCase()}`);
}

/**
 * Saves the settings of an account. When the context changes, the history gets a new version by
 * `editor`, the address of the signed-in user.
 */
export async function updateAccountDetails(
  env: Env,
  userId: string,
  id: string,
  details: AccountDetails,
  editor: string,
): Promise<void> {
  const current = await env.DB.prepare("SELECT context FROM accounts WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ context: string }>();
  if (!current) return;
  const p = details.permissions;
  const context = cleanContext(details.context).slice(0, MAX_CONTEXT_CHARS);
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `UPDATE accounts SET name = ?, context = ?, allow_send = ?, allow_invite = ?, allow_reply = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(
      details.name.slice(0, 100),
      context,
      p.sendEmail ? 1 : 0,
      p.sendInvitations ? 1 : 0,
      p.replyToInvitations ? 1 : 0,
      now,
      id,
      userId,
    ),
  ];
  if (context !== current.context) statements.push(insertUserVersion(env, id, context, editor, now));
  await env.DB.batch(statements);
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
  if (acct) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM context_versions WHERE account_id = ?").bind(id),
      env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").bind(id, userId),
    ]);
  }
  return acct;
}

// ---------- context history ----------

// accounts.context always holds the text of the latest accepted version. Only the functions in
// this section change either of them, and each one changes both in one batch.

/** The longest context that Mailroom stores, in characters. */
export const MAX_CONTEXT_CHARS = 8000;

/** Returns a context with LF line breaks only. Browsers send the line breaks of a text box as CRLF. */
const cleanContext = (text: string) => text.replace(/\r\n?/g, "\n");


/**
 * A version of the context notes of an account, or a change to them that an agent proposed and
 * that waits for a decision. Mailroom keeps only accepted versions in the history.
 */
export interface ContextVersion {
  id: number;
  account_id: string;
  context: string;
  /** An agent's change is `proposed` until the user accepts it. A user's change is `accepted` when it is saved. */
  status: "proposed" | "accepted";
  author_kind: "user" | "agent";
  /** The email address of the user, or the name of the OAuth client of the agent. */
  author: string;
  /** The OAuth client ID of the agent. */
  client_id: string | null;
  /** A name that the agent gave for itself. Mailroom cannot verify it. */
  agent_label: string | null;
  /** The reason that the agent gave for the change. */
  reason: string | null;
  /** The accepted version that was current when the agent proposed the change. */
  base_id: number | null;
  /** The version that the user restored to make this version. */
  restored_from: number | null;
  /**
   * The proposal that the user edited to make this version. The proposal is the accepted version just
   * before this one, and its text was never in effect.
   */
  edited_from: number | null;
  created_at: number;
  /** When the change became current. Null for a proposal. */
  decided_at: number | null;
  /** The email address of the user who saved or accepted the change. Null for a proposal. */
  decided_by: string | null;
}

/** An agent that proposes a change to a context. */
export interface ContextAgent {
  /** The OAuth client ID from the access token of the agent. */
  clientId: string | null;
  /** The name of the OAuth client, from its registration. */
  clientName: string;
  /** A name that the agent gave for itself, for example the name of a scheduled task. */
  label: string | null;
}

/** The state of the context history of one account. */
export interface ContextSummary {
  /** The current version, or null when the context was never set. */
  latest: ContextVersion | null;
  /** The number of accepted versions. */
  versions: number;
  /** True when a proposal waits for a decision. */
  hasProposal: boolean;
}

const LATEST_ACCEPTED_ID =
  "(SELECT id FROM context_versions WHERE account_id = ? AND status = 'accepted' ORDER BY decided_at DESC, id DESC LIMIT 1)";

/** The earlier version that a version by the user comes from, when it is not a plain edit. */
type UserVersionSource = { restoredFrom: number } | { editedFrom: number };

function insertUserVersion(env: Env, accountId: string, context: string, editor: string, now: number, source?: UserVersionSource) {
  return env.DB.prepare(
    `INSERT INTO context_versions (account_id, context, status, author_kind, author, restored_from, edited_from, created_at, decided_at, decided_by)
     VALUES (?, ?, 'accepted', 'user', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    accountId,
    context,
    editor,
    source && "restoredFrom" in source ? source.restoredFrom : null,
    source && "editedFrom" in source ? source.editedFrom : null,
    now,
    now,
    editor,
  );
}

const setAccountContext = (env: Env, userId: string, accountId: string, context: string, now: number) =>
  env.DB.prepare("UPDATE accounts SET context = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(
    context,
    now,
    accountId,
    userId,
  );

/** Returns the context history state of each account of the user, by account ID. An account without history has no entry. */
export async function contextSummaries(env: Env, userId: string): Promise<Map<string, ContextSummary>> {
  const [counts, latest] = await env.DB.batch([
    env.DB.prepare(
      `SELECT cv.account_id, SUM(cv.status = 'accepted') AS versions, SUM(cv.status = 'proposed') AS proposals
       FROM context_versions cv JOIN accounts a ON a.id = cv.account_id WHERE a.user_id = ? GROUP BY cv.account_id`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT cv.* FROM context_versions cv JOIN accounts a ON a.id = cv.account_id
       WHERE a.user_id = ? AND cv.id = (SELECT id FROM context_versions x WHERE x.account_id = cv.account_id
         AND x.status = 'accepted' ORDER BY x.decided_at DESC, x.id DESC LIMIT 1)`,
    ).bind(userId),
  ]);
  const latestByAccount = new Map((latest.results as unknown as ContextVersion[]).map((v) => [v.account_id, v]));
  const out = new Map<string, ContextSummary>();
  for (const row of counts.results as { account_id: string; versions: number; proposals: number }[]) {
    out.set(row.account_id, {
      latest: latestByAccount.get(row.account_id) ?? null,
      versions: row.versions,
      hasProposal: row.proposals > 0,
    });
  }
  return out;
}

/**
 * Returns the accepted versions of the context of an account, oldest first, and the proposal that
 * waits for a decision, or null. An account has at most one proposal. The result is empty when the
 * account does not belong to the user.
 */
export async function contextHistory(
  env: Env,
  userId: string,
  accountId: string,
): Promise<{ versions: ContextVersion[]; proposal: ContextVersion | null }> {
  const { results } = await env.DB.prepare(
    `SELECT cv.* FROM context_versions cv JOIN accounts a ON a.id = cv.account_id
     WHERE a.user_id = ? AND cv.account_id = ? AND cv.status IN ('accepted', 'proposed')
     ORDER BY COALESCE(cv.decided_at, cv.created_at), cv.id`,
  )
    .bind(userId, accountId)
    .all<ContextVersion>();
  return {
    versions: results.filter((v) => v.status === "accepted"),
    proposal: results.find((v) => v.status === "proposed") ?? null,
  };
}

/**
 * Saves a change to the context of an account that an agent proposes. The context does not change
 * until the user accepts the proposal. An account has at most one proposal: give the ID of the
 * proposal that waits as `replaces`, and Mailroom deletes it in the same batch. Returns the ID of the
 * new proposal, or `conflict` when another proposal waits, for example because another agent replaced
 * `replaces` a moment ago.
 * Precondition: `context` has at most MAX_CONTEXT_CHARS characters.
 */
export async function proposeContext(
  env: Env,
  accountId: string,
  change: { context: string; reason: string; agent: ContextAgent; replaces?: number },
): Promise<number | "conflict"> {
  const insert = env.DB.prepare(
    `INSERT INTO context_versions (account_id, context, status, author_kind, author, client_id, agent_label, reason, base_id, created_at)
     VALUES (?, ?, 'proposed', 'agent', ?, ?, ?, ?, ${LATEST_ACCEPTED_ID}, ?)`,
  )
    .bind(
      accountId,
      cleanContext(change.context),
      change.agent.clientName,
      change.agent.clientId,
      change.agent.label,
      change.reason,
      accountId,
      Date.now(),
    );
  const remove =
    change.replaces === undefined
      ? []
      : [
          env.DB.prepare("DELETE FROM context_versions WHERE id = ? AND account_id = ? AND status = 'proposed'").bind(
            change.replaces,
            accountId,
          ),
        ];
  try {
    const results = await env.DB.batch([...remove, insert]);
    return results[results.length - 1].meta.last_row_id;
  } catch (e) {
    // The unique index context_versions_one_proposal allows one waiting proposal for each account.
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) return "conflict";
    throw e;
  }
}

/**
 * Accepts or rejects a proposal. An accepted proposal becomes a version in the history. When `text`
 * differs from the proposal, the user edited it: the history gets the proposal and then a version by
 * the user with `text`, and only `text` becomes the current context. Otherwise the proposal becomes
 * the current context. Mailroom deletes a rejected proposal.
 * Precondition: `text` has at most MAX_CONTEXT_CHARS characters.
 * Returns `not_found` when the proposal does not exist, does not belong to the user, or already has a decision.
 */
export async function decideProposal(
  env: Env,
  userId: string,
  accountId: string,
  proposalId: number,
  decision: { accept: boolean; editor: string; text?: string },
): Promise<"accepted" | "edited" | "rejected" | "not_found"> {
  const proposal = await env.DB.prepare(
    `SELECT cv.context FROM context_versions cv JOIN accounts a ON a.id = cv.account_id
     WHERE a.user_id = ? AND cv.account_id = ? AND cv.id = ? AND cv.status = 'proposed'`,
  )
    .bind(userId, accountId, proposalId)
    .first<{ context: string }>();
  if (!proposal) return "not_found";
  if (!decision.accept) {
    await env.DB.prepare("DELETE FROM context_versions WHERE id = ? AND status = 'proposed'").bind(proposalId).run();
    return "rejected";
  }
  const now = Date.now();
  const accept = env.DB.prepare(
    "UPDATE context_versions SET status = 'accepted', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'proposed'",
  ).bind(now, decision.editor, proposalId);
  const edited = decision.text === undefined ? undefined : cleanContext(decision.text);
  if (edited === undefined || edited === proposal.context) {
    await env.DB.batch([accept, setAccountContext(env, userId, accountId, proposal.context, now)]);
    return "accepted";
  }
  // The edited version has a larger ID, so it follows the proposal in the history.
  await env.DB.batch([
    accept,
    insertUserVersion(env, accountId, edited, decision.editor, now, { editedFrom: proposalId }),
    setAccountContext(env, userId, accountId, edited, now),
  ]);
  return "edited";
}

/**
 * Makes an earlier version the current context again. The history gets a new version by `editor`
 * with the text of the earlier version. Returns `unchanged` when the text is the same as the current
 * context, and `not_found` when the version does not exist or does not belong to the user.
 */
export async function restoreContextVersion(
  env: Env,
  userId: string,
  accountId: string,
  versionId: number,
  editor: string,
): Promise<"restored" | "unchanged" | "not_found"> {
  const version = await env.DB.prepare(
    `SELECT cv.context, a.context AS current FROM context_versions cv JOIN accounts a ON a.id = cv.account_id
     WHERE a.user_id = ? AND cv.account_id = ? AND cv.id = ? AND cv.status = 'accepted'`,
  )
    .bind(userId, accountId, versionId)
    .first<{ context: string; current: string }>();
  if (!version) return "not_found";
  if (version.context === version.current) return "unchanged";
  const now = Date.now();
  await env.DB.batch([
    insertUserVersion(env, accountId, version.context, editor, now, { restoredFrom: versionId }),
    setAccountContext(env, userId, accountId, version.context, now),
  ]);
  return "restored";
}
