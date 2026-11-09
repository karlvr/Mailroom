import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Chosen at deploy time. Unlocks the setup wizard and protects stored tokens. */
  ADMIN_PASSWORD: string;
  /** Optional display name shown in the UI and to Claude. */
  APP_NAME?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What Claude's access token carries (set in completeAuthorization). */
export interface Props {
  userId: string;
  email: string;
}

export const appName = (env: Env) => env.APP_NAME || "Mailroom";
