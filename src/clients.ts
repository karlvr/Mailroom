import type { Env } from "./env";

/** The name that Mailroom shows for an OAuth client when it cannot get the name from the registration. */
export const UNKNOWN_CLIENT = "Unknown app";

/** Returns the name of an OAuth client from its registration, or UNKNOWN_CLIENT when Mailroom cannot get it. */
export async function clientName(env: Env, clientId: string): Promise<string> {
  try {
    return (await env.OAUTH_PROVIDER.lookupClient(clientId))?.clientName?.trim() || UNKNOWN_CLIENT;
  } catch {
    // A client ID that is a URL fails when its metadata document cannot be loaded.
    return UNKNOWN_CLIENT;
  }
}

/** Returns the host of an OAuth client ID that is a URL, which the OAuth provider verified. Returns null for other client IDs. */
export function clientHost(clientId: string | null): string | null {
  if (!clientId?.startsWith("https://")) return null;
  try {
    return new URL(clientId).host;
  } catch {
    return null;
  }
}

/** A Claude connection of a user: an OAuth client that has a live grant from the user. */
export interface ClaudeConnection {
  clientId: string;
  /** The name of the OAuth client, from its registration. */
  name: string;
}

/**
 * Returns the current Claude connections of the user. An app that registers again gets a new client
 * ID, and its old grant stays until it expires. So for each app, only the client with the newest live
 * grant is a current connection. An app is a client name and the host of its client ID.
 */
export async function claudeConnections(env: Env, userId: string): Promise<ClaudeConnection[]> {
  const now = Date.now() / 1000;
  // The time of the newest live grant of each client, in seconds.
  const grantedAt = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
    for (const g of page.items) {
      if (g.expiresAt !== undefined && g.expiresAt <= now) continue;
      grantedAt.set(g.clientId, Math.max(grantedAt.get(g.clientId) ?? 0, g.createdAt));
    }
    cursor = page.cursor;
  } while (cursor);

  const newest = new Map<string, ClaudeConnection & { grantedAt: number }>();
  for (const [clientId, at] of grantedAt) {
    const name = await clientName(env, clientId);
    const app = `${name}\n${clientHost(clientId) ?? ""}`;
    const seen = newest.get(app);
    if (!seen || seen.grantedAt < at) newest.set(app, { clientId, name, grantedAt: at });
  }
  return [...newest.values()].map(({ clientId, name }) => ({ clientId, name }));
}
