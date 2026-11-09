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

// ---------- tool lists ----------

/** Records that an agent connection of the user, identified by its OAuth client ID, loaded the tool list with `fingerprint`. */
export async function recordToolList(env: Env, userId: string, clientId: string, fingerprint: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tool_lists (user_id, client_id, fingerprint, listed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET fingerprint = excluded.fingerprint, listed_at = excluded.listed_at`,
  )
    .bind(userId, clientId, fingerprint, Date.now())
    .run();
}

/** Returns the fingerprint of the tool list that each agent connection of the user loaded last, by OAuth client ID. */
export async function loadedToolLists(env: Env, userId: string): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare("SELECT client_id, fingerprint FROM tool_lists WHERE user_id = ?")
    .bind(userId)
    .all<{ client_id: string; fingerprint: string }>();
  return new Map(results.map((r) => [r.client_id, r.fingerprint]));
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
  /** 1 when the owner allows agents to send email from this mailbox, otherwise 0. */
  allow_send: number;
  /** 1 when the owner allows agents to send calendar invitations from this account, otherwise 0. */
  allow_invite: number;
  /** 1 when the owner allows agents to reply to calendar invitations for this account, otherwise 0. */
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
  /** True when agents may send email from this mailbox. */
  sendEmail: boolean;
  /** True when agents may invite guests to events, and change or delete events that have other guests. */
  sendInvitations: boolean;
  /** True when agents may accept, decline or tentatively accept invitations. */
  rsvp: boolean;
}

/** The label of the setting that controls each permission, as the owner sees it on the web page. */
export const PERMISSION_LABELS: Record<keyof AccountPermissions, string> = {
  sendEmail: "Allow sending email",
  sendInvitations: "Allow sending calendar invitations",
  rsvp: "Allow RSVPs",
};

/** Returns the permissions that the owner gave to an account. */
export function accountPermissions(a: Account): AccountPermissions {
  return { sendEmail: a.allow_send === 1, sendInvitations: a.allow_invite === 1, rsvp: a.allow_reply === 1 };
}

/** Returns the Google permissions that the stored refresh token of the account grants. */
export function grantedScopes(a: Account): string[] {
  return (a.scopes ?? "").split(" ").filter(Boolean);
}

/** The settings of a linked mailbox that its owner controls. */
export interface AccountDetails {
  /** A short name for the mailbox. */
  name: string;
  /** Notes for agents about the purpose of the mailbox and how to treat it. */
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

/** Saves a linked Google account, or updates the access of an account that the user linked before. Returns the ID of the account. */
export async function saveLinkedAccount(env: Env, userId: string, link: LinkedGoogleAccount): Promise<string> {
  const now = Date.now();
  const id = randomToken(9);
  const enc = await encrypt(await dataKey(env), link.refreshToken, `refresh:${userId}:${link.email.toLowerCase()}`);
  const row = await env.DB.prepare(
    `INSERT INTO accounts (id, user_id, email, name, context, refresh_token, scopes, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', ?, ?, 'ok', ?, ?)
     ON CONFLICT(user_id, email) DO UPDATE SET
       refresh_token = excluded.refresh_token, scopes = excluded.scopes, status = 'ok', status_detail = NULL,
       updated_at = excluded.updated_at
     RETURNING id`,
  )
    .bind(id, userId, link.email, enc, link.scopes.join(" "), now, now)
    .first<{ id: string }>();
  if (!row) throw new Error("The database did not return the ID of the linked account.");
  return row.id;
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
  const p = details.permissions;
  const now = Date.now();
  const update = env.DB.prepare(
    `UPDATE accounts SET name = ?, allow_send = ?, allow_invite = ?, allow_reply = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).bind(details.name.slice(0, 100), p.sendEmail ? 1 : 0, p.sendInvitations ? 1 : 0, p.rsvp ? 1 : 0, now, id, userId);
  const change = await userChange(env, userId, { kind: "account", accountId: id }, details.context, editor, now);
  await env.DB.batch([update, ...change]);
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
      env.DB.prepare("DELETE FROM context_versions WHERE account_id = ?").bind(versionKey(userId, { kind: "account", accountId: id })),
      env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").bind(id, userId),
    ]);
  }
  return acct;
}

// ---------- context history ----------

// The live context of a subject always holds the text of the latest accepted version of that
// subject. The live context of an account is accounts.context, and the live global context is
// users.context. Only the functions in this section change the live context or the versions, and
// each one changes both in one batch.

/** The longest context that Mailroom stores, in characters. */
export const MAX_CONTEXT_CHARS = 8000;

/** Returns a context with LF line breaks only. Browsers send the line breaks of a text box as CRLF. */
const cleanContext = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * The owner of a set of context notes: the global context of a user, which applies to every account
 * of the user, or the context of one account. Each subject has its own live context, history and
 * proposal.
 */
export type ContextSubject = { kind: "global" } | { kind: "account"; accountId: string };

/** The global context of the user. */
export const GLOBAL_CONTEXT = { kind: "global" } as const satisfies ContextSubject;

/**
 * A version of the context notes of a subject, or a change to them that an agent proposed and
 * that waits for a decision. Mailroom keeps only accepted versions in the history.
 */
export interface ContextVersion {
  id: number;
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

/** The state of the context history of one subject. */
export interface ContextSummary {
  /** The current version, or null when the context was never set. */
  latest: ContextVersion | null;
  /** The number of accepted versions. */
  versions: number;
  /** True when a proposal waits for a decision. */
  hasProposal: boolean;
}

/** The context history state of all the subjects of a user. */
export interface ContextSummaries {
  /** The live global context, and its history state. The state is null when the global context has no history. */
  global: { context: string; summary: ContextSummary | null };
  /** The history state of each account, by account ID. An account without history has no entry. */
  accounts: Map<string, ContextSummary>;
}

/** The context notes of one subject, with their history. */
export interface ContextHistory {
  /** The text of the live context. */
  live: string;
  /** The accepted versions, oldest first. The text of the last version is the live context. */
  versions: ContextVersion[];
  /** The proposal that waits for a decision, or null. A subject has at most one proposal. */
  proposal: ContextVersion | null;
}

// context_versions.account_id holds the account ID for the context of an account, and "global:" and
// the user ID for the global context. Account IDs never contain ":".
const versionKey = (userId: string, s: ContextSubject) => (s.kind === "global" ? `global:${userId}` : s.accountId);

/** Returns a statement that reads the live context of a subject. It reads no row when the subject does not belong to the user. */
const selectLive = (env: Env, userId: string, s: ContextSubject) =>
  s.kind === "global"
    ? env.DB.prepare("SELECT context FROM users WHERE id = ?").bind(userId)
    : env.DB.prepare("SELECT context FROM accounts WHERE id = ? AND user_id = ?").bind(s.accountId, userId);

const setLiveContext = (env: Env, userId: string, s: ContextSubject, context: string, now: number) =>
  s.kind === "global"
    ? env.DB.prepare("UPDATE users SET context = ? WHERE id = ?").bind(context, userId)
    : env.DB.prepare("UPDATE accounts SET context = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(
        context,
        now,
        s.accountId,
        userId,
      );

const firstRow = <T>(result: D1Result) => result.results[0] as T | undefined;

const LATEST_ACCEPTED_ID =
  "(SELECT id FROM context_versions WHERE account_id = ? AND status = 'accepted' ORDER BY decided_at DESC, id DESC LIMIT 1)";

/** The earlier version that a version by the user comes from, when it is not a plain edit. */
type UserVersionSource = { restoredFrom: number } | { editedFrom: number };

function insertUserVersion(env: Env, key: string, context: string, editor: string, now: number, source?: UserVersionSource) {
  return env.DB.prepare(
    `INSERT INTO context_versions (account_id, context, status, author_kind, author, restored_from, edited_from, created_at, decided_at, decided_by)
     VALUES (?, ?, 'accepted', 'user', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    key,
    context,
    editor,
    source && "restoredFrom" in source ? source.restoredFrom : null,
    source && "editedFrom" in source ? source.editedFrom : null,
    now,
    now,
    editor,
  );
}

/**
 * Returns the statements that make `text` the live context of a subject, as a change by `editor`, the
 * address of the signed-in user. Returns no statements when the text is the same as the live context,
 * or when the subject does not belong to the user.
 */
async function userChange(
  env: Env,
  userId: string,
  subject: ContextSubject,
  text: string,
  editor: string,
  now: number,
): Promise<D1PreparedStatement[]> {
  const live = await liveContext(env, userId, subject);
  const context = cleanContext(text).slice(0, MAX_CONTEXT_CHARS);
  if (live === null || context === live) return [];
  return [setLiveContext(env, userId, subject, context, now), insertUserVersion(env, versionKey(userId, subject), context, editor, now)];
}

/** Returns the text of the live context of a subject, or null when the subject does not belong to the user. */
export async function liveContext(env: Env, userId: string, subject: ContextSubject): Promise<string | null> {
  return (await selectLive(env, userId, subject).first<{ context: string }>())?.context ?? null;
}

/** Saves the global context of a user. When the text changes, the history gets a new version by `editor`, the address of the signed-in user. */
export async function saveGlobalContext(env: Env, userId: string, text: string, editor: string): Promise<void> {
  const statements = await userChange(env, userId, GLOBAL_CONTEXT, text, editor, Date.now());
  if (statements.length) await env.DB.batch(statements);
}

/** Returns the live global context of a user and the context history state of the global context and of each account. */
export async function contextSummaries(env: Env, userId: string): Promise<ContextSummaries> {
  const globalKey = versionKey(userId, GLOBAL_CONTEXT);
  const owned = "(cv.account_id IN (SELECT id FROM accounts WHERE user_id = ?) OR cv.account_id = ?)";
  const [live, counts, latest] = await env.DB.batch([
    selectLive(env, userId, GLOBAL_CONTEXT),
    env.DB.prepare(
      `SELECT cv.account_id AS key, SUM(cv.status = 'accepted') AS versions, SUM(cv.status = 'proposed') AS proposals
       FROM context_versions cv WHERE ${owned} GROUP BY cv.account_id`,
    ).bind(userId, globalKey),
    env.DB.prepare(
      `SELECT cv.* FROM context_versions cv
       WHERE ${owned} AND cv.id = (SELECT id FROM context_versions x WHERE x.account_id = cv.account_id
         AND x.status = 'accepted' ORDER BY x.decided_at DESC, x.id DESC LIMIT 1)`,
    ).bind(userId, globalKey),
  ]);
  const latestByKey = new Map(
    (latest.results as unknown as (ContextVersion & { account_id: string })[]).map((v) => [v.account_id, v]),
  );
  const out: ContextSummaries = {
    global: { context: firstRow<{ context: string }>(live)?.context ?? "", summary: null },
    accounts: new Map(),
  };
  for (const row of counts.results as { key: string; versions: number; proposals: number }[]) {
    const summary = { latest: latestByKey.get(row.key) ?? null, versions: row.versions, hasProposal: row.proposals > 0 };
    if (row.key === globalKey) out.global.summary = summary;
    else out.accounts.set(row.key, summary);
  }
  return out;
}

/** Returns the live context of a subject and its history, or null when the subject does not belong to the user. */
export async function contextHistory(env: Env, userId: string, subject: ContextSubject): Promise<ContextHistory | null> {
  const [live, rows] = await env.DB.batch([
    selectLive(env, userId, subject),
    env.DB.prepare(
      `SELECT * FROM context_versions WHERE account_id = ? AND status IN ('accepted', 'proposed')
       ORDER BY COALESCE(decided_at, created_at), id`,
    ).bind(versionKey(userId, subject)),
  ]);
  const current = firstRow<{ context: string }>(live);
  if (!current) return null;
  const results = rows.results as unknown as ContextVersion[];
  return {
    live: current.context,
    versions: results.filter((v) => v.status === "accepted"),
    proposal: results.find((v) => v.status === "proposed") ?? null,
  };
}

/**
 * Saves a change to the context of a subject that an agent proposes. The context does not change
 * until the user accepts the proposal. A subject has at most one proposal: give the ID of the
 * proposal that waits as `replaces`, and Mailroom deletes it in the same batch. Returns the ID of the
 * new proposal, or `conflict` when another proposal waits, for example because another agent replaced
 * `replaces` a moment ago.
 * Precondition: the subject belongs to the user, and `context` has at most MAX_CONTEXT_CHARS characters.
 */
export async function proposeContext(
  env: Env,
  userId: string,
  subject: ContextSubject,
  change: { context: string; reason: string; agent: ContextAgent; replaces?: number },
): Promise<number | "conflict"> {
  const key = versionKey(userId, subject);
  const insert = env.DB.prepare(
    `INSERT INTO context_versions (account_id, context, status, author_kind, author, client_id, agent_label, reason, base_id, created_at)
     VALUES (?, ?, 'proposed', 'agent', ?, ?, ?, ?, ${LATEST_ACCEPTED_ID}, ?)`,
  ).bind(
    key,
    cleanContext(change.context),
    change.agent.clientName,
    change.agent.clientId,
    change.agent.label,
    change.reason,
    key,
    Date.now(),
  );
  const remove =
    change.replaces === undefined
      ? []
      : [
          env.DB.prepare("DELETE FROM context_versions WHERE id = ? AND account_id = ? AND status = 'proposed'").bind(
            change.replaces,
            key,
          ),
        ];
  try {
    const results = await env.DB.batch([...remove, insert]);
    return results[results.length - 1].meta.last_row_id;
  } catch (e) {
    // The unique index context_versions_one_proposal allows one waiting proposal for each subject.
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
  subject: ContextSubject,
  proposalId: number,
  decision: { accept: boolean; editor: string; text?: string },
): Promise<"accepted" | "edited" | "rejected" | "not_found"> {
  const key = versionKey(userId, subject);
  const [live, found] = await env.DB.batch([
    selectLive(env, userId, subject),
    env.DB.prepare("SELECT context FROM context_versions WHERE account_id = ? AND id = ? AND status = 'proposed'").bind(
      key,
      proposalId,
    ),
  ]);
  const proposal = firstRow<{ context: string }>(found);
  if (!firstRow(live) || !proposal) return "not_found";
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
    await env.DB.batch([accept, setLiveContext(env, userId, subject, proposal.context, now)]);
    return "accepted";
  }
  // The edited version has a larger ID, so it follows the proposal in the history.
  await env.DB.batch([
    accept,
    insertUserVersion(env, key, edited, decision.editor, now, { editedFrom: proposalId }),
    setLiveContext(env, userId, subject, edited, now),
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
  subject: ContextSubject,
  versionId: number,
  editor: string,
): Promise<"restored" | "unchanged" | "not_found"> {
  const key = versionKey(userId, subject);
  const [live, found] = await env.DB.batch([
    selectLive(env, userId, subject),
    env.DB.prepare("SELECT context FROM context_versions WHERE account_id = ? AND id = ? AND status = 'accepted'").bind(
      key,
      versionId,
    ),
  ]);
  const current = firstRow<{ context: string }>(live);
  const version = firstRow<{ context: string }>(found);
  if (!current || !version) return "not_found";
  if (version.context === current.context) return "unchanged";
  const now = Date.now();
  await env.DB.batch([
    insertUserVersion(env, key, version.context, editor, now, { restoredFrom: versionId }),
    setLiveContext(env, userId, subject, version.context, now),
  ]);
  return "restored";
}
