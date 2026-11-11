// Replaces the D1 parts of src/db.ts in the tests. Everything else comes from the real module.
export * from "../../src/db";
import * as real from "../../src/db";
import type { Account, GoogleConfig } from "../../src/db";
// @ts-expect-error The module is JavaScript without types.
import { sqliteEnv } from "./sqlite-env.mjs";

export const TEST_ACCOUNT: Account = {
  id: "acct-1",
  user_id: "user-1",
  email: "me@example.com",
  name: "Test",
  context: "",
  status: "ok",
  status_detail: null,
  allow_send: 0,
  allow_reply_email: 0,
  allow_invite: 0,
  allow_reply: 0,
  scopes: "https://www.googleapis.com/auth/gmail.modify",
  created_at: 0,
  updated_at: 0,
};

/** More accounts of the user, for the tools that work in every account. The tests add and remove them. */
export const OTHER_ACCOUNTS: Account[] = [];

export const listAccounts = async (): Promise<Account[]> => [TEST_ACCOUNT, ...OTHER_ACCOUNTS];
export const findAccount = async (_env: unknown, _user: string, ref: string): Promise<Account | null> =>
  [TEST_ACCOUNT, ...OTHER_ACCOUNTS].find((a) => a.email === ref.toLowerCase()) ?? null;
export const getGoogleConfig = async (): Promise<GoogleConfig> => ({ clientId: "client", clientSecret: "secret" }) as GoogleConfig;

/** Returns the refresh token of an account. Fails for an account with the status "relink", as for a token that cannot be decrypted. */
export const getRefreshToken = async (_env: unknown, a: Account): Promise<string> => {
  if (a.status === "relink") throw new Error("The token cannot be decrypted.");
  return "refresh-token";
};
export const setAccountStatus = async (): Promise<void> => {};

// The previews of the bulk tools, in memory, by token hash.
export const confirmations = new Map<string, { accountId: string; action: string; threadIds: string[]; expiresAt: number }>();

export const saveBulkConfirmation = async (
  _env: unknown,
  c: { tokenHash: string; accountId: string; action: string; threadIds: string[]; expiresAt: number },
): Promise<void> => {
  confirmations.set(c.tokenHash, { accountId: c.accountId, action: c.action, threadIds: c.threadIds, expiresAt: c.expiresAt });
};

export const takeBulkConfirmation = async (_env: unknown, tokenHash: string, accountId: string, action: string): Promise<string[] | null> => {
  const c = confirmations.get(tokenHash);
  if (!c || c.accountId !== accountId || c.action !== action || c.expiresAt <= Date.now()) return null;
  confirmations.delete(tokenHash);
  return c.threadIds;
};

export const contextSummaries = async () => ({ global: { context: "", summary: null }, accounts: new Map() });

// The agent state runs the real SQL on SQLite. resetState gives each test an empty database.
let stateEnv = sqliteEnv().env;
export const resetState = () => {
  stateEnv = sqliteEnv().env;
};
export const readState: typeof real.readState = (_env, ...rest) => real.readState(stateEnv, ...rest);
export const writeState: typeof real.writeState = (_env, ...rest) => real.writeState(stateEnv, ...rest);
export const deleteState: typeof real.deleteState = (_env, ...rest) => real.deleteState(stateEnv, ...rest);
