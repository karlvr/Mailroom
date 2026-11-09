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
<footer>Self-hosted mailbox connector for Claude. Claude sends email only from mailboxes where you allow sending.</footer>
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
    `<h1>Set up ${esc(app)}</h1>
<p class="muted">Enter the admin password you chose when you deployed this Worker.</p>
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
<p class="muted">About ten minutes, once. Each link opens the exact Google Cloud screen — keep this page open in another tab.</p>
${s.saved ? `<div class="notice">Saved. <a href="/">Sign in and link your mailboxes →</a></div>` : ""}
${s.error ? `<div class="notice">${esc(s.error)}</div>` : ""}
${step(
  1,
  "Create a Google Cloud project",
  `<p><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Create a project</a> — any name, e.g. <code>${esc(app)}</code>. Make sure it's selected in the project picker at the top before the next steps.</p>`,
  s.configured,
)}
${step(
  2,
  "Turn on the Gmail API",
  `<p><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Open the Gmail API</a> and click <b>Enable</b>.</p>`,
  s.configured,
)}
${step(
  3,
  "Set up the sign-in screen",
  `<ol>
<li><a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Open Google Auth Platform</a> → <b>Get started</b>. App name: <code>${esc(app)}</code>; support email: yours.</li>
<li>Audience: choose <b>External</b> (this lets mailboxes from any Google account or Workspace link). Contact email: yours. Agree and <b>Create</b>.</li>
<li>Go to <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Audience</a> and click <b>Publish app</b> → Confirm. <span class="muted">This matters: left in “Testing”, Google expires access every 7 days.</span></li>
</ol>
<p class="muted">You don't need to submit for verification or add scopes. Google will show a “Google hasn't verified this app” screen when you link a mailbox — click <b>Advanced</b> → <b>Go to ${esc(app)}</b>. That's expected for a private app.</p>`,
  s.configured,
)}
${step(
  4,
  "Create the OAuth client",
  `<ol>
<li><a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Create a client</a>. Application type: <b>Web application</b>.</li>
<li>Under <b>Authorized redirect URIs</b>, add exactly:</li></ol>
${copyBox(redirect)}
<p>Click <b>Create</b>, then copy the Client ID and Client secret into step 5. <span class="muted">Google only shows the secret once — if you lose it, add a new secret on the client's page.</span></p>`,
  s.configured,
)}
${step(
  5,
  "Paste the credentials",
  `<form method="post" action="/setup">
<input type="hidden" name="csrf" value="${esc(s.csrf)}">
<label for="cid">Client ID</label><input id="cid" type="text" name="client_id" value="${esc(s.clientId)}" placeholder="…apps.googleusercontent.com" required>
<label for="cs">Client secret</label><input id="cs" type="password" name="client_secret" placeholder="${s.configured ? "Saved — leave blank to keep" : "GOCSPX-…"}" ${s.configured ? "" : "required"} autocomplete="off">
<label for="al">Who can use this</label>
<textarea id="al" name="allowlist" placeholder="you@example.com&#10;@yourcompany.com" required>${esc(s.allowlist)}</textarea>
<p class="muted">One per line. A full address allows that person; <code>@domain.com</code> allows anyone at that domain. Each person links and sees only their own mailboxes.</p>
<div class="row"><button>Save</button></div></form>`,
)}
${step(
  6,
  "For each Google Workspace you use: trust the app",
  `<p>Workspace admins can block unverified apps. If linking a Workspace mailbox fails with “access blocked”, in that organisation's admin console:</p>
<ol><li><a href="https://admin.google.com/ac/owl/list?tab=configuredApps" target="_blank" rel="noopener">Open App access control</a> → <b>Configure new app</b>.</li>
<li>Search for your Client ID${s.clientId ? ":" : "."}</li></ol>
${s.clientId ? copyBox(s.clientId) : ""}
<p>Choose the app, scope it to your organisation, and set access to <b>Trusted</b>. Personal @gmail.com accounts don't need this.</p>`,
)}
<p><a href="/">← Back to ${esc(app)}</a></p>`,
    { app },
  );
}

export function landingPage(app: string, configured: boolean) {
  return page(
    "Welcome",
    `<h1>${esc(app)}</h1>
<p class="muted">Gives Claude access to all your Gmail and Google Workspace mailboxes, each with its own context.</p>
<div class="card">${
      configured
        ? `<p>Sign in with Google to manage your mailboxes.</p><a class="btn" href="/login">Sign in with Google</a>`
        : `<p>This deployment isn't connected to Google yet.</p><a class="btn" href="/setup">Start setup</a>`
    }</div>
${configured ? `<p class="muted"><a href="/setup">Admin setup</a></p>` : ""}`,
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
<label>Short name <span class="muted">(how Claude refers to it)</span></label>
<input type="text" name="name" value="${esc(a.name)}" placeholder="e.g. Support">
<label>Context for Claude</label>
<textarea name="context" placeholder="What this mailbox is for, who matters, what's urgent, what to ignore, how to sign replies…">${esc(a.context)}</textarea>
<label class="check"><input type="checkbox" name="allow_send" value="1"${a.allow_send === 1 ? " checked" : ""}> Allow sending</label>
<p class="muted">When this is on, Claude can send email from this mailbox. ${esc(app)} instructs Claude to send only when you tell it to, never because an email asks. This reduces the risk that an email tricks Claude, but it cannot remove the risk.</p>
<div class="row"><button>Save</button>
<a class="btn secondary" href="/accounts/link?hint=${encodeURIComponent(a.email)}">Re-link</a>
<button class="danger" formaction="/accounts/${esc(a.id)}/remove" onclick="return confirm('Remove ${esc(a.email)}? This also revokes Google access.')">Remove</button></div>
</form></div>`;
  return page(
    "Mailboxes",
    `${flash ? `<div class="notice">${esc(flash)}</div>` : ""}
<h1>Your mailboxes</h1>
<p class="muted">Link each Gmail or Workspace address. Claude reads them only through this Worker. Claude can label, draft and trash, and it can send only from mailboxes where you turn on <b>Allow sending</b>.</p>
${accounts.map(acct).join("") || `<div class="card"><p>No mailboxes linked yet.</p></div>`}
<div class="row"><a class="btn" href="/accounts/link">+ Link a mailbox</a></div>

<div class="card" style="margin-top:28px"><h2>Connect Claude</h2>
<ol><li>In Claude, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</li>
<li>Name it <code>${esc(app)}</code> and paste this URL:</li></ol>
${copyBox(mcpUrl)}
<ol start="3"><li>Click <b>Connect</b> and sign in with <b>${esc(who)}</b> when asked.</li></ol>
<p class="muted">Claude then has tools to list your mailboxes, search, read threads, apply labels, create drafts and trash threads for every mailbox above. It can send drafts only from mailboxes where you allow sending.</p></div>`,
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
<p>${d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>.` : "This app registered itself; its name isn't verified."} Access will be sent to <b>${esc(d.redirectHost)}</b>.</p>
${d.redirectIsLoopback ? `<div class="notice">This sends access to an app on your computer. Continue only if you just started connecting from it.</div>` : ""}
<p>It will be able to search, read, label, draft and trash email in:</p>
<ul>${accounts.map((a) => `<li>${esc(a.name || a.email)}${a.name ? ` <span class="muted">${esc(a.email)}</span>` : ""}${a.allow_send === 1 ? ` <span class="pill">can send</span>` : ""}</li>`).join("") || "<li class='muted'>No mailboxes linked yet — anything you link later is included.</li>"}</ul>
<p class="muted">It can send email only from mailboxes marked <b>can send</b>. You can revoke this any time by removing the connector in Claude.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button name="decision" value="approve">Allow</button><button class="secondary" name="decision" value="deny">Deny</button></div>
</form></div>`,
    { app, who },
  );
}
