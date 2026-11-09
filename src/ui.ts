import type { Account } from "./db";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f5d50;--accent-fg:#fff;--warn:#9a5b00;--warn-bg:#fff4e0;--bad:#a3271f;--code:#f0eee8}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ecebe7;--muted:#9c9a94;--line:#33322f;--accent:#7fbfa9;--accent-fg:#10201b;--warn:#f0b35a;--warn-bg:#2d2414;--bad:#ff8a80;--code:#2a2927}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
header.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;gap:12px;flex-wrap:wrap}
header.top .brand{font-weight:650;font-size:18px;letter-spacing:-.01em}
header.top .who{color:var(--muted);font-size:14px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px}
h2{font-size:19px;margin:0 0 6px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
.step{display:grid;grid-template-columns:34px 1fr;gap:12px}
.step .n{width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;font-weight:650;font-size:14px}
.step.done .n{background:var(--line);color:var(--muted)}
ul,ol{margin:6px 0 12px;padding-left:20px}
li{margin:3px 0}
code,.copy{font:13.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px;padding:2px 6px;word-break:break-all}
.copy{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;margin:6px 0 10px}
.copy button{flex:none}
a{color:var(--accent)}
.btn,button{display:inline-block;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:8px 14px;font:inherit;font-size:15px;font-weight:550;text-decoration:none;cursor:pointer}
.btn.secondary,button.secondary{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
.copy button{padding:3px 10px;font-size:13px}
label{display:block;font-weight:550;font-size:14px;margin:12px 0 4px}
label.check{display:flex;gap:8px;align-items:center}
input[type=text],input[type=password],input[type=email],textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;font-size:15px}
textarea{min-height:110px;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}
.notice{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:10px 12px;margin:12px 0;font-size:14.5px}
.acct-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline}
.pill{font-size:12px;border-radius:999px;padding:2px 8px;border:1px solid var(--line);color:var(--muted)}
.pill.bad{border-color:var(--bad);color:var(--bad)}
details summary{cursor:pointer;color:var(--accent);font-weight:550}
footer{margin-top:40px;color:var(--muted);font-size:13px}
`;

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(()=>{const t=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=t,1200)})})`;

export function page(title: string, body: string, opts: { app: string; who?: string } = { app: "Mailroom" }): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(opts.app)}</title><style>${CSS}</style></head>
<body><main>
<header class="top"><div class="brand">✉︎ ${esc(opts.app)}</div>${
    opts.who ? `<div class="who">${esc(opts.who)} · <a href="/logout">Sign out</a></div>` : ""
  }</header>
${body}
<footer>${esc(opts.app)} is a self-hosted mailbox connector for Claude. Claude can send email only from a mailbox where you select Allow sending. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</main><script>${COPY_JS}</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export const copyBox = (value: string) =>
  `<div class="copy"><span>${esc(value)}</span><button type="button" data-copy="${esc(value)}">Copy</button></div>`;

const section = (title: string, body: string) => `<div class="card"><h2>${title}</h2>${body}</div>`;

/**
 * Returns the domain to add as an authorized domain in Google Auth Platform for a host name.
 * Google accepts only a registrable domain, such as `example.com` or `you.workers.dev`. This knows
 * the `workers.dev` suffix and assumes a one-label public suffix for other hosts.
 */
const authorizedDomain = (hostname: string) =>
  hostname.split(".").slice(hostname.endsWith(".workers.dev") ? -3 : -2).join(".");

export function messagePage(app: string, title: string, message: string, link?: { href: string; text: string }) {
  return page(
    title,
    `<h1>${esc(title)}</h1><div class="card"><p>${esc(message)}</p>${
      link ? `<a class="btn" href="${esc(link.href)}">${esc(link.text)}</a>` : ""
    }</div>`,
    { app },
  );
}

export function adminLoginPage(app: string, error?: string) {
  return page(
    "Setup",
    `<h1>${esc(app)} setup</h1>
<p class="muted">Enter the admin password that you chose when you deployed this Worker.</p>
<div class="card"><form method="post" action="/setup/login">
${error ? `<div class="notice">${esc(error)}</div>` : ""}
<label for="pw">Admin password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<div class="row"><button>Continue</button></div></form></div>`,
    { app },
  );
}

export function setupPage(
  app: string,
  origin: string,
  s: { configured: boolean; clientId: string; allowlist: string; csrf: string; saved?: boolean; error?: string },
) {
  const redirect = `${origin}/google/callback`;
  const step = (n: number, title: string, body: string, done = false) =>
    `<div class="card step${done ? " done" : ""}"><div class="n">${n}</div><div><h2>${title}</h2>${body}</div></div>`;
  return page(
    "Setup",
    `<h1>Connect to Google</h1>
<p class="muted">You do this setup only once. It takes about 10 minutes. Each link opens the Google Cloud screen for that step in a new tab. Keep this page open.</p>
${s.saved ? `<div class="notice">${esc(app)} saved the settings. <a href="/">Sign in and link your mailboxes →</a></div>` : ""}
${s.error ? `<div class="notice">${esc(s.error)}</div>` : ""}
${step(
  1,
  "Create a Google Cloud project",
  `<p><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Create a project</a>. You can use any name, for example <code>${esc(app)}</code>. Before you do the next steps, select the project in the project picker at the top of the page.</p>`,
  s.configured,
)}
${step(
  2,
  "Enable the Gmail API",
  `<p><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Open the Gmail API</a> and click <b>Enable</b>.</p>`,
  s.configured,
)}
${step(
  3,
  "Configure the sign-in screen",
  `<ol>
<li><a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Open Google Auth Platform</a>, then click <b>Get started</b>. For the app name, enter <code>${esc(app)}</code>. For the support email, enter your address.</li>
<li>For the audience, choose <b>External</b>. With this setting, you can link mailboxes from any Google account or Workspace. For the contact email, enter your address. Accept the policy, then click <b>Create</b>.</li>
<li>Open <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">Branding</a>. Google does not let you publish the app until you complete these fields. Under <b>App domain</b>, enter these links:
<div class="muted">Application home page</div>${copyBox(`${origin}/`)}
<div class="muted">Application privacy policy link</div>${copyBox(`${origin}/privacy`)}
<div class="muted">Application terms of service link</div>${copyBox(`${origin}/terms`)}
Under <b>Authorized domains</b>, add this domain:${copyBox(authorizedDomain(new URL(origin).hostname))}
Do not upload a logo. With a logo, Google must verify the app before you can publish it. Click <b>Save</b>.</li>
<li>Open <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Audience</a>, then click <b>Publish app</b> and <b>Confirm</b>. <span class="muted">Do not skip this step. If you leave the app in “Testing”, Google expires the access every 7 days.</span></li>
</ol>
<p class="muted">You do not need app verification from Google, and you do not need to add scopes. When you link a mailbox, Google shows the warning “Google hasn't verified this app”. Click <b>Advanced</b>, then click <b>Go to ${esc(app)}</b>. This warning is normal for a private app.</p>`,
  s.configured,
)}
${step(
  4,
  "Create the OAuth client",
  `<ol>
<li><a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Create a client</a>. For the application type, choose <b>Web application</b>. For the name, enter <code>${esc(app)}</code>.</li>
<li>Under <b>Authorized redirect URIs</b>, add this URI exactly:</li></ol>
${copyBox(redirect)}
<p>Click <b>Create</b>. Then copy the Client ID and the Client secret into step 5. <span class="muted">Google shows the secret only once. If you lose it, add a new secret on the page of the client.</span></p>`,
  s.configured,
)}
${step(
  5,
  "Paste the credentials",
  `<form method="post" action="/setup">
<input type="hidden" name="csrf" value="${esc(s.csrf)}">
<label for="cid">Client ID</label><input id="cid" type="text" name="client_id" value="${esc(s.clientId)}" placeholder="…apps.googleusercontent.com" required>
<label for="cs">Client secret</label><input id="cs" type="password" name="client_secret" placeholder="${s.configured ? "Leave this field empty to keep the saved secret" : "GOCSPX-…"}" ${s.configured ? "" : "required"} autocomplete="off">
<label for="al">Who can use this</label>
<textarea id="al" name="allowlist" placeholder="you@example.com&#10;@yourcompany.com" required>${esc(s.allowlist)}</textarea>
<p class="muted">Enter one entry on each line. A full address gives access to that person. An entry such as <code>@domain.com</code> gives access to every person at that domain. Each person links their own mailboxes and sees only those mailboxes.</p>
<div class="row"><button>Save</button></div></form>`,
)}
${step(
  6,
  "Trust the app in each Google Workspace",
  `<p>A Workspace admin can block unverified apps. If you cannot link a Workspace mailbox because of the error “access blocked”, do these steps in the Admin Console of that organisation:</p>
<ol><li><a href="https://admin.google.com/ac/owl/list?tab=configuredApps" target="_blank" rel="noopener">Open App access control</a>, then click <b>Configure new app</b>.</li>
<li>Search for your Client ID${s.clientId ? ":" : "."}</li></ol>
${s.clientId ? copyBox(s.clientId) : ""}
<p>Select the app. Set the scope to your organisation. Set the access to <b>Trusted</b>. A personal @gmail.com account does not need this step.</p>`,
)}
<p><a href="/">← Back to ${esc(app)}</a></p>`,
    { app },
  );
}

export function landingPage(app: string, configured: boolean) {
  return page(
    "Welcome",
    `<h1>${esc(app)}</h1>
<p class="muted">${esc(app)} gives Claude access to all your Gmail and Google Workspace mailboxes. Each mailbox has its own context.</p>
<div class="card">${
      configured
        ? `<p>Sign in with Google to manage your mailboxes.</p><a class="btn" href="/login">Sign in with Google</a>`
        : `<p>${esc(app)} is not connected to Google yet.</p><a class="btn" href="/setup">Start setup</a>`
    }</div>
${configured ? `<p class="muted"><a href="/setup">Admin setup</a></p>` : ""}`,
    { app },
  );
}

export function privacyPage(app: string, origin: string) {
  const a = esc(app);
  return page(
    "Privacy policy",
    `<h1>Privacy policy</h1>
<p class="muted">This policy applies to ${a} at <b>${esc(new URL(origin).host)}</b>. ${a} connects Gmail and Google Workspace mailboxes to Claude. The person or organisation that deployed ${a} operates it. Cloudflare hosts it.</p>
${section(
  `Data that ${a} stores`,
  `<ul><li>Your Google account ID, your email address, and the times of your first and last sign-in.</li>
<li>For each mailbox that you link: its address, its short name, its context notes, the <b>Allow sending</b> setting and a Google refresh token. ${a} encrypts the token before it stores it.</li>
<li>Your web session, and a record of each Claude connection that you approve.</li></ul>
<p>${a} does not store the content of your email.</p>`,
)}
${section(
  `How ${a} uses your Google data`,
  `<p>${a} uses Google sign-in to get your verified email address. ${a} uses the Gmail API only when Claude calls one of the ${a} tools. ${a} then sends the result to Claude through the connection that you approved.</p>
<p>The tools can search, read, label, draft and trash email. ${a} sends email only from a mailbox where you select <b>Allow sending</b>.</p>
<p>${a} does not sell your data. ${a} does not use your data for advertising or to train AI models.</p>
<p>The use and transfer of information that ${a} receives from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>`,
)}
${section(
  "Who receives your data",
  `<ul><li><b>Google</b> supplies the sign-in and the Gmail API. Your email stays in Gmail.</li>
<li><b>Anthropic</b> receives the email data that ${a} sends to Claude. The <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener">Anthropic privacy policy</a> and your Claude settings apply to that data.</li>
<li><b>Cloudflare</b> runs ${a} and stores its data. Cloudflare can keep request logs.</li></ul>
<p>${a} does not send your data to other parties.</p>`,
)}
${section(
  "Remove your data",
  `<ul><li>To unlink a mailbox, click <b>Remove</b> on the ${a} home page. ${a} deletes the stored token and revokes the Google access of that mailbox.</li>
<li>To stop the access of Claude, remove the ${a} connector in Claude.</li>
<li>You can also revoke the access of ${a} on the <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">third-party connections</a> page of your Google account.</li>
<li>To delete all your data, contact the operator of ${a}.</li></ul>`,
)}
${section(
  "Contact",
  `<p>For questions about this policy, contact the person or organisation that gave you access to ${a}.</p>`,
)}`,
    { app },
  );
}

export function termsPage(app: string, origin: string) {
  const a = esc(app);
  return page(
    "Terms of service",
    `<h1>Terms of service</h1>
<p class="muted">These terms apply to ${a} at <b>${esc(new URL(origin).host)}</b>. The person or organisation that deployed ${a} operates it. When you use ${a}, you agree to these terms.</p>
${section(
  "Access",
  `<p>Only the people that the operator allows can sign in. Link only the mailboxes that you have permission to use.</p>`,
)}
${section(
  "Your instructions",
  `<p>Claude uses ${a} when you instruct it. You are responsible for your instructions and for the actions that Claude does because of them. Select <b>Allow sending</b> only for a mailbox where you accept that Claude can send email.</p>
<p>${a} instructs Claude to treat email content as data, never as instructions. This instruction reduces the risk that an email tricks Claude, but it cannot remove the risk.</p>`,
)}
${section(
  "No warranty",
  `<p>The operator supplies ${a} “as is”, without warranty of any kind. To the extent that the law permits, the operator is not liable for loss or damage from the use of ${a}. This includes email that Claude sends, labels or trashes.</p>`,
)}
${section(
  "Changes",
  `<p>The operator can change these terms or stop your access at any time. You can stop the use of ${a} at any time. For information about how ${a} uses your data, read the <a href="/privacy">privacy policy</a>.</p>`,
)}`,
    { app },
  );
}

export function dashboardPage(
  app: string,
  origin: string,
  who: string,
  accounts: Account[],
  csrf: string,
  flash?: string,
) {
  const mcpUrl = `${origin}/mcp`;
  const acct = (a: Account) => `<div class="card">
<div class="acct-head"><h2>${esc(a.name || a.email)}</h2>${
    a.status === "ok"
      ? `<span class="pill">Linked</span>`
      : `<span class="pill bad">Needs re-linking</span>`
  }</div>
${a.name ? `<p class="muted">${esc(a.email)}</p>` : ""}
${a.status !== "ok" ? `<div class="notice">${esc(a.status_detail || "Google access stopped working.")} <a href="/accounts/link?hint=${encodeURIComponent(a.email)}">Re-link</a></div>` : ""}
<form method="post" action="/accounts/${esc(a.id)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Short name <span class="muted">(Claude uses this name for the mailbox)</span></label>
<input type="text" name="name" value="${esc(a.name)}" placeholder="For example, Support">
<label>Context for Claude</label>
<textarea name="context" placeholder="What this mailbox is for, who matters, what's urgent, what to ignore, how to sign replies…">${esc(a.context)}</textarea>
<label class="check"><input type="checkbox" name="allow_send" value="1"${a.allow_send === 1 ? " checked" : ""}> Allow sending</label>
<p class="muted">When you select <b>Allow sending</b>, Claude can send email from this mailbox. ${esc(app)} instructs Claude to send email only when you instruct it, never because an email requests it. This instruction reduces the risk that an email tricks Claude, but it cannot remove the risk.</p>
<div class="row"><button>Save</button>
<a class="btn secondary" href="/accounts/link?hint=${encodeURIComponent(a.email)}">Re-link</a>
<button class="danger" formaction="/accounts/${esc(a.id)}/remove" onclick="return confirm('Remove ${esc(a.email)}? This also revokes its Google access.')">Remove</button></div>
</form></div>`;
  return page(
    "Mailboxes",
    `${flash ? `<div class="notice">${esc(flash)}</div>` : ""}
<h1>Your mailboxes</h1>
<p class="muted">Link each Gmail or Workspace mailbox. Claude can read these mailboxes only through ${esc(app)}. Claude can label, draft and trash email. Claude can send email only from a mailbox where you select <b>Allow sending</b>.</p>
${accounts.map(acct).join("") || `<div class="card"><p>You have no linked mailboxes.</p></div>`}
<div class="row"><a class="btn" href="/accounts/link">+ Link a mailbox</a></div>

<div class="card" style="margin-top:28px"><h2>Connect Claude</h2>
<ol><li>In Claude, open <b>Settings → Connectors</b>.</li>
<li>Click <b>Add custom connector</b>.</li>
<li>Enter <code>${esc(app)}</code> as the name and this URL as the URL:</li></ol>
${copyBox(mcpUrl)}
<ol start="4"><li>Click <b>Connect</b>.</li>
<li>If the ${esc(app)} sign-in page opens, sign in with <b>${esc(who)}</b>.</li>
<li>Click <b>Allow</b> on the ${esc(app)} consent page.</li></ol>
<p class="muted">Claude then has tools for every mailbox above. With these tools, Claude can list your mailboxes, search, read threads, apply labels, create drafts and trash threads. Claude can send drafts only from a mailbox where you select <b>Allow sending</b>.</p></div>`,
    { app, who },
  );
}

export function consentPage(
  app: string,
  who: string,
  d: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean },
  handle: string,
  accounts: Account[],
) {
  return page(
    "Allow access",
    `<h1>Allow ${esc(d.clientName)} to use your mailboxes?</h1>
<div class="card">
<p>${d.clientDomain ? `This app is from <b>${esc(d.clientDomain)}</b>.` : `This app registered itself. ${esc(app)} cannot verify its name.`} If you click <b>Allow</b>, ${esc(app)} sends the access to <b>${esc(d.redirectHost)}</b>.</p>
${d.redirectIsLoopback ? `<div class="notice">That address is on your computer. Continue only if you started this connection from an app on your computer a moment ago.</div>` : ""}
<p>The app can search, read, label, draft and trash email in these mailboxes:</p>
<ul>${accounts.map((a) => `<li>${esc(a.name || a.email)}${a.name ? ` <span class="muted">${esc(a.email)}</span>` : ""}${a.allow_send === 1 ? ` <span class="pill">can send</span>` : ""}</li>`).join("") || "<li class='muted'>You have no linked mailboxes. The access also includes the mailboxes that you link later.</li>"}</ul>
<p class="muted">The app can send email only from a mailbox with the mark <b>can send</b>. To revoke this access at any time, remove the connector in Claude.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button name="decision" value="approve">Allow</button><button class="secondary" name="decision" value="deny">Deny</button></div>
</form></div>`,
    { app, who },
  );
}
