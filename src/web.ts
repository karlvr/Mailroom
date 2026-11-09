import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { appName, type Env } from "./env";
import { randomToken, safeEqual, sha256 } from "./crypto";
import {
  deleteAccount,
  getAllowlist,
  getConfig,
  getGoogleConfig,
  getRefreshToken,
  isAllowed,
  listAccounts,
  saveGoogleConfig,
  saveLinkedAccount,
  setConfig,
  updateAccountDetails,
  upsertUser,
} from "./db";
import { GMAIL_SCOPE, authorizeUrl, exchangeCode, pkcePair, revokeToken } from "./google";
import {
  adminLoginPage,
  consentPage,
  dashboardPage,
  landingPage,
  messagePage,
  setupPage,
} from "./ui";

const USER_COOKIE = "__Host-mr_s";
const ADMIN_COOKIE = "__Host-mr_a";
const GSTATE_COOKIE = "__Host-mr_g";
const USER_TTL = 30 * 24 * 3600;
const ADMIN_TTL = 3600;

interface UserSession {
  userId: string;
  email: string;
  csrf: string;
}

interface GoogleState {
  purpose: "login" | "link";
  verifier: string;
  userId?: string;
  next?: string;
}

// ---------- helpers ----------

function cookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("Cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/** Only allow same-site relative paths as post-login destinations. */
const safeNext = (next: string | null | undefined) =>
  next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";

/** Returns the signed-in person's session, or null when there is none or their address is no longer on the allowlist. */
async function getUserSession(env: Env, req: Request): Promise<UserSession | null> {
  const token = cookie(req, USER_COOKIE);
  if (!token) return null;
  const session = await env.OAUTH_KV.get<UserSession>(`mr:sess:${await sha256(token)}`, "json");
  if (!session || !isAllowed(await getAllowlist(env), session.email)) return null;
  return session;
}

async function getAdminSession(env: Env, req: Request): Promise<{ csrf: string } | null> {
  const token = cookie(req, ADMIN_COOKIE);
  if (!token) return null;
  return env.OAUTH_KV.get<{ csrf: string }>(`mr:admin:${await sha256(token)}`, "json");
}

async function form(req: Request): Promise<FormData> {
  return req.formData();
}

function checkCsrf(f: FormData, expected: string): boolean {
  return safeEqual(String(f.get("csrf") ?? ""), expected);
}

// ---------- router ----------

export async function handleWeb(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const app = appName(env);
  const path = url.pathname;
  const method = req.method;

  if (!env.ADMIN_PASSWORD) {
    return messagePage(
      app,
      "Almost there",
      "This Worker has no ADMIN_PASSWORD secret. Add one in the Cloudflare dashboard (Worker → Settings → Variables and Secrets), then reload this page.",
    );
  }

  try {
    if (path === "/healthz") return new Response("ok");
    if (path === "/" && method === "GET") return home(req, env, origin, app);
    if (path === "/setup" && method === "GET") return setupGet(req, env, origin, app);
    if (path === "/setup/login" && method === "POST") return setupLogin(req, env, origin, app);
    if (path === "/setup" && method === "POST") return setupSave(req, env, origin, app);
    if (path === "/login" && method === "GET") return startGoogle(req, env, origin, app, "login");
    if (path === "/logout") return logout(req, env);
    if (path === "/accounts/link" && method === "GET") return startGoogle(req, env, origin, app, "link");
    if (path === "/google/callback" && method === "GET") return googleCallback(req, env, origin, app);
    if (path === "/authorize") return authorize(req, env, app);
    const m = path.match(/^\/accounts\/([\w-]+)(\/remove)?$/);
    if (m && method === "POST") return accountPost(req, env, ctx, m[1], !!m[2]);
    return messagePage(app, "Not found", "There's nothing at this address.", { href: "/", text: "Go home" });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return redirect(e.redirectTo);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      const msg = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
      return messagePage(app, "Couldn't connect", msg);
    }
    throw e;
  }
}

// ---------- pages ----------

async function home(req: Request, env: Env, origin: string, app: string) {
  const cfg = await getGoogleConfig(env);
  const session = await getUserSession(env, req);
  if (!cfg || !session) return landingPage(app, !!cfg);
  const flash = new URL(req.url).searchParams.get("msg") ?? undefined;
  const accounts = await listAccounts(env, session.userId);
  return dashboardPage(app, origin, session.email, accounts, session.csrf, flash);
}

async function setupGet(req: Request, env: Env, origin: string, app: string, extra: { saved?: boolean; error?: string } = {}) {
  const admin = await getAdminSession(env, req);
  if (!admin) return adminLoginPage(app);
  const cfg = await getGoogleConfig(env);
  return setupPage(app, origin, {
    configured: !!cfg,
    clientId: (await getConfig(env, "google_client_id")) ?? "",
    allowlist: (await getAllowlist(env)).join("\n"),
    csrf: admin.csrf,
    ...extra,
  });
}

async function setupLogin(req: Request, env: Env, origin: string, app: string) {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const failKey = `mr:pwfail:${ip}`;
  const fails = Number((await env.OAUTH_KV.get(failKey)) ?? 0);
  if (fails >= 10) return adminLoginPage(app, "Too many attempts. Try again in 15 minutes.");
  const f = await form(req);
  if (!safeEqual(String(f.get("password") ?? ""), env.ADMIN_PASSWORD)) {
    await env.OAUTH_KV.put(failKey, String(fails + 1), { expirationTtl: 900 });
    return adminLoginPage(app, "That password doesn't match the ADMIN_PASSWORD secret.");
  }
  const token = randomToken();
  await env.OAUTH_KV.put(`mr:admin:${await sha256(token)}`, JSON.stringify({ csrf: randomToken(16) }), {
    expirationTtl: ADMIN_TTL,
  });
  return redirect("/setup", [setCookie(ADMIN_COOKIE, token, ADMIN_TTL)]);
}

async function setupSave(req: Request, env: Env, origin: string, app: string) {
  const admin = await getAdminSession(env, req);
  if (!admin) return adminLoginPage(app);
  const f = await form(req);
  if (!checkCsrf(f, admin.csrf)) return setupGet(req, env, origin, app, { error: "That form expired. Try again." });
  const clientId = String(f.get("client_id") ?? "").trim();
  const secret = String(f.get("client_secret") ?? "").trim();
  const allowlist = String(f.get("allowlist") ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return setupGet(req, env, origin, app, { error: "The Client ID should end in .apps.googleusercontent.com." });
  }
  if (!allowlist.length || allowlist.some((e) => !/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(e))) {
    return setupGet(req, env, origin, app, {
      error: "Add at least one email address or @domain under “Who can use this”.",
    });
  }
  const existing = await getGoogleConfig(env);
  const clientSecret = secret || existing?.clientSecret;
  if (!clientSecret) return setupGet(req, env, origin, app, { error: "Paste the Client secret." });
  await saveGoogleConfig(env, { clientId, clientSecret });
  await setConfig(env, "allowed_emails", allowlist.join("\n"));
  return setupGet(req, env, origin, app, { saved: true });
}

async function logout(req: Request, env: Env) {
  const token = cookie(req, USER_COOKIE);
  if (token) await env.OAUTH_KV.delete(`mr:sess:${await sha256(token)}`);
  return redirect("/", [setCookie(USER_COOKIE, "", 0), setCookie(ADMIN_COOKIE, "", 0)]);
}

// ---------- Google sign-in and mailbox linking ----------

async function startGoogle(req: Request, env: Env, origin: string, app: string, purpose: "login" | "link") {
  const cfg = await getGoogleConfig(env);
  if (!cfg) return redirect("/setup");
  const url = new URL(req.url);
  let userId: string | undefined;
  if (purpose === "link") {
    const session = await getUserSession(env, req);
    if (!session) return redirect(`/login?next=${encodeURIComponent("/accounts/link" + url.search)}`);
    userId = session.userId;
  }
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const data: GoogleState = { purpose, verifier, userId, next: safeNext(url.searchParams.get("next")) };
  await env.OAUTH_KV.put(`mr:gstate:${await sha256(state)}`, JSON.stringify(data), { expirationTtl: 600 });
  return redirect(
    authorizeUrl(cfg, origin, {
      state,
      challenge,
      mailbox: purpose === "link",
      loginHint: url.searchParams.get("hint") ?? undefined,
    }),
    [setCookie(GSTATE_COOKIE, state, 600)],
  );
}

async function googleCallback(req: Request, env: Env, origin: string, app: string) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const bound = cookie(req, GSTATE_COOKIE) ?? "";
  if (!state || !safeEqual(state, bound)) {
    return messagePage(app, "Sign-in expired", "Start again from this browser.", { href: "/", text: "Start again" });
  }
  const key = `mr:gstate:${await sha256(state)}`;
  const data = await env.OAUTH_KV.get<GoogleState>(key, "json");
  await env.OAUTH_KV.delete(key);
  const clear = setCookie(GSTATE_COOKIE, "", 0);
  if (!data) return messagePage(app, "Sign-in expired", "That sign-in link was already used or took too long.", { href: "/", text: "Start again" });

  const err = url.searchParams.get("error");
  if (err) {
    return messagePage(
      app,
      err === "access_denied" ? "Cancelled" : "Google said no",
      err === "access_denied"
        ? "Nothing was changed."
        : `Google returned “${err}”. If this is a Workspace account, its admin may need to trust the app (setup step 6).`,
      { href: "/", text: "Back" },
    );
  }
  const cfg = await getGoogleConfig(env);
  if (!cfg) return redirect("/setup");
  const result = await exchangeCode(cfg, origin, url.searchParams.get("code") ?? "", data.verifier);

  if (data.purpose === "login") {
    if (!result.emailVerified || !isAllowed(await getAllowlist(env), result.email)) {
      return messagePage(
        app,
        "Not on the list",
        `${result.email} isn't allowed to use this deployment. The admin can add it in setup.`,
        { href: "/login", text: "Use another account" },
      );
    }
    await upsertUser(env, result.sub, result.email);
    const token = randomToken();
    const session: UserSession = { userId: result.sub, email: result.email, csrf: randomToken(16) };
    await env.OAUTH_KV.put(`mr:sess:${await sha256(token)}`, JSON.stringify(session), { expirationTtl: USER_TTL });
    return redirect(safeNext(data.next), [clear, setCookie(USER_COOKIE, token, USER_TTL)]);
  }

  // purpose: link
  const session = await getUserSession(env, req);
  if (!session || session.userId !== data.userId) return redirect("/", [clear]);
  if (!result.scopes.includes(GMAIL_SCOPE)) {
    return messagePage(
      app,
      "Gmail permission missing",
      "Google's screen lets you untick permissions. Link again and leave the Gmail box ticked.",
      { href: `/accounts/link?hint=${encodeURIComponent(result.email)}`, text: "Link again" },
    );
  }
  if (!result.refreshToken) {
    return messagePage(app, "Google didn't grant lasting access", "Try linking again.", {
      href: `/accounts/link?hint=${encodeURIComponent(result.email)}`,
      text: "Link again",
    });
  }
  await saveLinkedAccount(env, session.userId, result.email, result.refreshToken);
  return redirect(`/?msg=${encodeURIComponent(`Linked ${result.email}. Add a name and some context so Claude knows what it's for.`)}`, [clear]);
}

async function accountPost(req: Request, env: Env, ctx: ExecutionContext, id: string, remove: boolean) {
  const session = await getUserSession(env, req);
  if (!session) return redirect("/");
  const f = await form(req);
  if (!checkCsrf(f, session.csrf)) return redirect("/?msg=That%20form%20expired.%20Try%20again.");
  if (remove) {
    const accounts = await listAccounts(env, session.userId);
    const acct = accounts.find((a) => a.id === id);
    if (acct) {
      const token = await getRefreshToken(env, acct).catch(() => null);
      await deleteAccount(env, session.userId, id);
      if (token) ctx.waitUntil(revokeToken(token));
      return redirect(`/?msg=${encodeURIComponent(`Removed ${acct.email} and revoked its Google access.`)}`);
    }
    return redirect("/");
  }
  await updateAccountDetails(env, session.userId, id, {
    name: String(f.get("name") ?? "").trim(),
    context: String(f.get("context") ?? "").trim(),
    allowSend: f.get("allow_send") === "1",
  });
  return redirect("/?msg=Saved.");
}

// ---------- OAuth for Claude (MCP clients) ----------

async function authorize(req: Request, env: Env, app: string) {
  const session = await getUserSession(env, req);
  const url = new URL(req.url);
  if (!session) {
    if (req.method !== "GET") return redirect("/");
    if (!(await getGoogleConfig(env))) {
      return messagePage(app, "Not set up yet", "Finish setup on this Worker before connecting Claude.", { href: "/setup", text: "Open setup" });
    }
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const oauth = env.OAUTH_PROVIDER;
  if (req.method === "GET") {
    const request = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const accounts = await listAccounts(env, session.userId);
    const res = consentPage(app, session.email, details, consent.handle, accounts);
    consent.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "set-cookie") res.headers.set(k, v);
    });
    for (const c of consent.headers.getSetCookie()) res.headers.append("Set-Cookie", c);
    res.headers.set("Content-Type", "text/html; charset=utf-8");
    return res;
  }

  const f = await form(req);
  const handle = String(f.get("handle") ?? "");
  if (f.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(req, handle);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: session.userId,
    metadata: { email: session.email },
    scope: approved.request.scope,
    props: { userId: session.userId, email: session.email },
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}
