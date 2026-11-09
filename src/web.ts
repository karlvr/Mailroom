import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { appName, type Env } from "./env";
import { randomToken, safeEqual, sha256 } from "./crypto";
import {
  type AccountPermissions,
  contextHistory,
  contextSummaries,
  decideProposal,
  MAX_CONTEXT_CHARS,
  deleteAccount,
  findAccount,
  getAllowlist,
  getConfig,
  getGoogleConfig,
  getRefreshToken,
  getSetupVersion,
  isAllowed,
  listAccounts,
  saveGoogleConfig,
  saveLinkedAccount,
  setConfig,
  setSetupVersion,
  restoreContextVersion,
  updateAccountDetails,
  upsertUser,
} from "./db";
import { GMAIL_SCOPE, authorizeUrl, exchangeCode, hasCalendar, pkcePair, revokeToken } from "./google";
import {
  APP_ICONS,
  PERMISSION_FIELDS,
  SETUP_VERSION,
  adminLoginPage,
  consentPage,
  contextPage,
  contextPreview,
  costsPage,
  dashboardPage,
  favicon,
  landingPage,
  messagePage,
  privacyPage,
  setupPage,
  termsPage,
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

  if (path === APP_ICONS.svg.path) return favicon();
  if (!env.ADMIN_PASSWORD) {
    return messagePage(
      app,
      "Set the admin password",
      "This Worker has no ADMIN_PASSWORD secret. In the Cloudflare dashboard, add the secret in Worker → Settings → Variables and Secrets. Then reload this page.",
    );
  }

  try {
    if (path === "/healthz") return new Response("ok");
    if (path === "/" && method === "GET") return home(req, env, origin, app);
    if (path === "/privacy" && method === "GET") return privacyPage(app, origin);
    if (path === "/terms" && method === "GET") return termsPage(app, origin);
    if (path === "/costs" && method === "GET") return costsPage(app);
    if (path === "/setup" && method === "GET") return setupGet(req, env, origin, app);
    if (path === "/setup/login" && method === "POST") return setupLogin(req, env, origin, app);
    if (path === "/setup" && method === "POST") return setupSave(req, env, origin, app);
    if (path === "/setup/confirm" && method === "POST") return setupConfirm(req, env, origin, app);
    if (path === "/login" && method === "GET") return startGoogle(req, env, origin, app, "login");
    if (path === "/logout") return logout(req, env);
    if (path === "/accounts/link" && method === "GET") return startGoogle(req, env, origin, app, "link");
    if (path === "/google/callback" && method === "GET") return googleCallback(req, env, origin, app);
    if (path === "/authorize") return authorize(req, env, app);
    const m = path.match(/^\/accounts\/([\w-]+)(\/remove)?$/);
    if (m && method === "POST") return accountPost(req, env, ctx, m[1], !!m[2]);
    const history = path.match(/^\/accounts\/([\w-]+)\/context$/);
    if (history && method === "GET") return contextGet(req, env, app, history[1]);
    const preview = path.match(/^\/accounts\/([\w-]+)\/context\/preview$/);
    if (preview && method === "POST") return previewPost(req, env, preview[1]);
    const proposal = path.match(/^\/accounts\/([\w-]+)\/context\/proposals\/(\d+)$/);
    if (proposal && method === "POST") return proposalPost(req, env, app, proposal[1], Number(proposal[2]));
    const restore = path.match(/^\/accounts\/([\w-]+)\/context\/versions\/(\d+)\/restore$/);
    if (restore && method === "POST") return restorePost(req, env, app, restore[1], Number(restore[2]));
    const notFound = messagePage(app, "Not found", "This page does not exist.", { href: "/", text: "Home page" });
    return new Response(notFound.body, { status: 404, headers: notFound.headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return redirect(e.redirectTo);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      const msg = e instanceof AuthorizationError ? e.description : `${app} could not verify this app.`;
      return messagePage(app, "Connection failed", msg);
    }
    throw e;
  }
}

// ---------- pages ----------

async function home(req: Request, env: Env, origin: string, app: string) {
  const cfg = await getGoogleConfig(env);
  const session = await getUserSession(env, req);
  if (!cfg || !session) return landingPage(app, origin, !!cfg);
  const flash = new URL(req.url).searchParams.get("msg") ?? undefined;
  const accounts = await listAccounts(env, session.userId);
  const history = await contextSummaries(env, session.userId);
  const setupOutdated = (await getSetupVersion(env)) < SETUP_VERSION;
  return dashboardPage(app, origin, session.email, accounts, history, session.csrf, { flash, setupOutdated });
}

async function setupGet(
  req: Request,
  env: Env,
  origin: string,
  app: string,
  extra: { saved?: boolean; confirmed?: boolean; error?: string } = {},
) {
  const admin = await getAdminSession(env, req);
  if (!admin) return adminLoginPage(app);
  const cfg = await getGoogleConfig(env);
  return setupPage(app, origin, {
    configured: !!cfg,
    completedVersion: await getSetupVersion(env),
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
  if (fails >= 10) return adminLoginPage(app, `${app} blocked this IP address after 10 incorrect passwords. Try again in 15 minutes.`);
  const f = await form(req);
  if (!safeEqual(String(f.get("password") ?? ""), env.ADMIN_PASSWORD)) {
    await env.OAUTH_KV.put(failKey, String(fails + 1), { expirationTtl: 900 });
    return adminLoginPage(app, "That password does not match the ADMIN_PASSWORD secret.");
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
    return setupGet(req, env, origin, app, { error: "The Client ID must end with .apps.googleusercontent.com." });
  }
  if (!allowlist.length || allowlist.some((e) => !/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(e))) {
    return setupGet(req, env, origin, app, {
      error: "Enter at least one entry under “Who can use this”. Each entry must be an email address or an @domain.",
    });
  }
  const existing = await getGoogleConfig(env);
  const clientSecret = secret || existing?.clientSecret;
  if (!clientSecret) return setupGet(req, env, origin, app, { error: "Paste the Client secret." });
  // An admin who saves the credentials for the first time followed the current steps.
  if ((await getSetupVersion(env)) === 0) await setSetupVersion(env, SETUP_VERSION);
  await saveGoogleConfig(env, { clientId, clientSecret });
  await setConfig(env, "allowed_emails", allowlist.join("\n"));
  return setupGet(req, env, origin, app, { saved: true });
}

async function setupConfirm(req: Request, env: Env, origin: string, app: string) {
  const admin = await getAdminSession(env, req);
  if (!admin) return adminLoginPage(app);
  const f = await form(req);
  if (!checkCsrf(f, admin.csrf)) return setupGet(req, env, origin, app, { error: "That form expired. Try again." });
  await setSetupVersion(env, SETUP_VERSION);
  return setupGet(req, env, origin, app, { confirmed: true });
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
  if (!data) return messagePage(app, "Sign-in expired", "You already used that sign-in link, or it expired.", { href: "/", text: "Start again" });

  const err = url.searchParams.get("error");
  if (err) {
    return messagePage(
      app,
      err === "access_denied" ? "Cancelled" : "Google denied access",
      err === "access_denied"
        ? `${app} made no changes.`
        : `Google returned the error “${err}”. If this is a Workspace account, an admin of that organisation may need to trust the app. See step 6 of the setup page.`,
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
        `${result.email} is not on the list of people who can use ${app}. The admin can add it on the setup page.`,
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
      `${app} did not get the Gmail permission. On the Google consent screen, you can clear each permission. When you link the mailbox again, keep the Gmail check box selected.`,
      { href: `/accounts/link?hint=${encodeURIComponent(result.email)}`, text: "Link again" },
    );
  }
  if (!result.refreshToken) {
    return messagePage(app, "Google did not grant lasting access", "Try to link the mailbox again.", {
      href: `/accounts/link?hint=${encodeURIComponent(result.email)}`,
      text: "Link again",
    });
  }
  await saveLinkedAccount(env, session.userId, {
    email: result.email,
    refreshToken: result.refreshToken,
    scopes: result.scopes,
  });
  const calendarNote = hasCalendar(result.scopes)
    ? ""
    : ` ${app} did not get the Calendar permissions, so Claude cannot use the calendar of this account. To add the calendar, click Re-link and keep the Calendar check boxes selected.`;
  return redirect(
    `/?msg=${encodeURIComponent(`${app} linked ${result.email}. Give the mailbox a short name and context notes. ${app} instructs Claude to read them before it works in that mailbox.${calendarNote}`)}`,
    [clear],
  );
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
      return redirect(`/?msg=${encodeURIComponent(`${appName(env)} removed ${acct.email} and revoked its Google access.`)}`);
    }
    return redirect("/");
  }
  const selected = (k: keyof AccountPermissions) => f.get(PERMISSION_FIELDS[k]) === "1";
  await updateAccountDetails(env, session.userId, id, {
    name: String(f.get("name") ?? "").trim(),
    context: String(f.get("context") ?? "").trim(),
    permissions: {
      sendEmail: selected("sendEmail"),
      sendInvitations: selected("sendInvitations"),
      replyToInvitations: selected("replyToInvitations"),
    },
  }, session.email);
  return redirect(`/?msg=${encodeURIComponent(`${appName(env)} saved your changes.`)}`);
}

// ---------- context history ----------

const historyUrl = (accountId: string, msg?: string) =>
  `/accounts/${encodeURIComponent(accountId)}/context${msg ? `?msg=${encodeURIComponent(msg)}` : ""}`;

async function contextGet(req: Request, env: Env, app: string, id: string) {
  const session = await getUserSession(env, req);
  const url = new URL(req.url);
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  const account = (await listAccounts(env, session.userId)).find((a) => a.id === id);
  if (!account) return messagePage(app, "Not found", "This mailbox does not exist, or it is not yours.", { href: "/", text: "Home page" });
  const { versions, proposals } = await contextHistory(env, session.userId, id);
  const compare = url.searchParams.get("compare");
  return contextPage(app, session.email, account, {
    versions,
    proposals,
    selectedId: Number(url.searchParams.get("v")) || undefined,
    compare: compare === "text" || compare === "next" || compare === "current" ? compare : "previous",
    csrf: session.csrf,
    flash: url.searchParams.get("msg") ?? undefined,
  });
}

async function proposalPost(req: Request, env: Env, app: string, id: string, proposalId: number) {
  const session = await getUserSession(env, req);
  if (!session) return redirect("/");
  const f = await form(req);
  if (!checkCsrf(f, session.csrf)) return redirect(historyUrl(id, "That form expired. Try again."));
  const accept = f.get("decision") === "accept";
  // The review form sends the text of the proposal, which the user can edit.
  const text = f.has("context") ? String(f.get("context")) : undefined;
  if (text !== undefined && text.replace(/\r\n/g, "\n").length > MAX_CONTEXT_CHARS) {
    return redirect(historyUrl(id, `The context can have at most ${MAX_CONTEXT_CHARS} characters. ${app} did not save your edits.`));
  }
  const result = await decideProposal(env, session.userId, id, proposalId, { accept, editor: session.email, text });
  const messages = {
    accepted: `${app} accepted the proposal. It is now the current context.`,
    edited: `${app} accepted the proposal with your edits. Your edited text is now the current context.`,
    rejected: `${app} rejected and deleted the proposal.`,
    not_found: "That proposal does not exist, or it already has a decision.",
  };
  return redirect(historyUrl(id, messages[result]));
}

/** Returns the diff of the current context of a mailbox and the posted text, as an HTML fragment. */
async function previewPost(req: Request, env: Env, id: string) {
  const session = await getUserSession(env, req);
  if (!session) return new Response(null, { status: 401 });
  const f = await form(req);
  if (!checkCsrf(f, session.csrf)) return new Response(null, { status: 403 });
  const account = await findAccount(env, session.userId, id);
  if (!account) return new Response(null, { status: 404 });
  return contextPreview(account.context, String(f.get("context") ?? ""));
}

async function restorePost(req: Request, env: Env, app: string, id: string, versionId: number) {
  const session = await getUserSession(env, req);
  if (!session) return redirect("/");
  const f = await form(req);
  if (!checkCsrf(f, session.csrf)) return redirect(historyUrl(id, "That form expired. Try again."));
  const result = await restoreContextVersion(env, session.userId, id, versionId, session.email);
  const messages = {
    restored: `${app} restored the version. It is now the current context.`,
    unchanged: "That version has the same text as the current context. The context did not change.",
    not_found: "That version does not exist.",
  };
  return redirect(historyUrl(id, messages[result]));
}

// ---------- OAuth for Claude (MCP clients) ----------

async function authorize(req: Request, env: Env, app: string) {
  const session = await getUserSession(env, req);
  const url = new URL(req.url);
  if (!session) {
    if (req.method !== "GET") return redirect("/");
    if (!(await getGoogleConfig(env))) {
      return messagePage(app, "Setup is not complete", "Complete the setup page before you connect Claude.", {
        href: "/setup",
        text: "Open the setup page",
      });
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
