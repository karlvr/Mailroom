import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Workers AI, to convert PDF and Office attachments to text. Absent when the deployment has no `ai` binding. */
  AI?: Ai;
  /** Chosen at deploy time. Unlocks the setup page and protects stored tokens. */
  ADMIN_PASSWORD: string;
  /** Optional display name shown in the UI and to agents. */
  APP_NAME?: string;
  /**
   * Optional. The shortest time in milliseconds between two Gmail batch requests of one tool call. The
   * default is 1000, which keeps the reads of one call under the Gmail rate limit of each user.
   */
  GMAIL_BATCH_INTERVAL_MS?: number;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What the access token of an agent carries (set in completeAuthorization). */
export interface Props {
  userId: string;
  email: string;
}

export const appName = (env: Env) => env.APP_NAME || "Mailroom";
