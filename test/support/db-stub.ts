// Replaces the D1 parts of src/db.ts in the tests. Everything else comes from the real module.
export * from "../../src/db";
import type { Account, GoogleConfig } from "../../src/db";

export const TEST_ACCOUNT: Account = {
  id: "acct-1",
  user_id: "user-1",
  email: "me@example.com",
  name: "Test",
  context: "",
  status: "ok",
  status_detail: null,
  allow_send: 0,
  allow_invite: 0,
  allow_reply: 0,
  scopes: "https://www.googleapis.com/auth/gmail.modify",
  created_at: 0,
  updated_at: 0,
};

export const listAccounts = async (): Promise<Account[]> => [TEST_ACCOUNT];
export const findAccount = async (_env: unknown, _user: string, ref: string): Promise<Account | null> =>
  ref.toLowerCase() === TEST_ACCOUNT.email ? TEST_ACCOUNT : null;
export const getGoogleConfig = async (): Promise<GoogleConfig> => ({ clientId: "client", clientSecret: "secret" }) as GoogleConfig;
export const getRefreshToken = async (): Promise<string> => "refresh-token";
export const setAccountStatus = async (): Promise<void> => {};
