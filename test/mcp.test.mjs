// Tests of the MCP tools: the bulk thread tools and send_draft. The test bundles the real src/mcp.ts with esbuild, replaces the D1
// parts of src/db.ts with test/support/db-stub.ts, and answers the Google requests with a fake Gmail.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
let dir;
let mod;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mailroom-test-"));
  const entry = join(dir, "entry.ts");
  await build({
    stdin: {
      contents: `
        export { buildServer, toolCatalog } from ${JSON.stringify(join(root, "src/mcp.ts"))};
        export { parseBatchResponse, batchRequestBody } from ${JSON.stringify(join(root, "src/google.ts"))};
        export { TEST_ACCOUNT, OTHER_ACCOUNTS, resetState } from ${JSON.stringify(join(root, "test/support/db-stub.ts"))};
        export { addressList } from ${JSON.stringify(join(root, "src/mime.ts"))};
        export { parseIcs } from ${JSON.stringify(join(root, "src/ics.ts"))};
        export { Client } from "@modelcontextprotocol/sdk/client/index.js";
        export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
      `,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(dir, "bundle.mjs"),
    logLevel: "silent",
    plugins: [
      {
        name: "db-stub",
        setup(b) {
          // Each import of ./db from src/ gets the stub. The stub itself imports the real module.
          b.onResolve({ filter: /^\.\/db$/ }, (args) =>
            args.importer.startsWith(join(root, "src")) ? { path: join(root, "test/support/db-stub.ts") } : undefined,
          );
          // The SQLite shim finds the migrations from its own folder, so it stays outside the bundle.
          b.onResolve({ filter: /sqlite-env\.mjs$/ }, (args) => ({ path: join(args.resolveDir, args.path), external: true }));
        },
      },
    ],
  });
  void entry;
  mod = await import(pathToFileURL(join(dir, "bundle.mjs")).href);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The date of a message in the fake Gmail without a date of its own. */
const DEFAULT_DATE = "Tue, 10 Nov 2026 09:00:00 +1300";

/** A fake Gmail with labels and threads. It records the requests it gets. */
class FakeGmail {
  constructor(threadCount) {
    this.labels = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "STARRED", name: "STARRED", type: "system" },
      { id: "Label_1", name: "Existing", type: "user" },
    ];
    this.threads = new Map();
    for (let i = 0; i < threadCount; i++) {
      this.threads.set(`t${i}`, { labels: new Set(["INBOX"]), subject: i % 2 === 0 ? "PopularityService failure" : "Lunch" });
    }
    this.batches = [];
    /** The query of each search, as threads.list gets it. */
    this.searches = [];
    /** Drafts by ID: the thread and the headers of each. */
    this.drafts = new Map();
    /** Threads for send_draft, by ID: the labels and headers of each message. */
    this.mailThreads = new Map();
    /** The IDs of the drafts that Gmail sent. */
    this.sent = [];
    /** The content of attachments that Gmail stores apart from their message, in base64url, by attachment ID. */
    this.attachments = new Map();
    /** The events of the primary calendar, and the query of each request for them. */
    this.events = [];
    this.eventQueries = [];
    /** When true, the calendar rejects each request for events with 410, as for an updatedMin that is too old. */
    this.eventsGone = false;
    /** The drafts that the upload API replaced: the ID, the metadata and the message of each. */
    this.uploads = [];
    /** The number of requests that the fake got, as Workers counts subrequests. */
    this.requests = 0;
    this.tokenRequests = 0;
    this.tokens = 0;
    /** The access tokens that this fake issued. Like Google, it accepts each of them. */
    this.issued = new Set();
    /** Thread IDs whose next change gets 429 once. A messages.batchModify request with a message of such a thread gets 429 for all its messages. */
    this.rateLimitOnce = new Set();
    /** The messages.batchModify requests that the fake got: the message IDs, and the labels to add and to remove. */
    this.modifyRequests = [];
    /** When set, each messages.batchModify request fails with this error, for example { code: 400, message: "..." }. */
    this.refuseModify = null;
    /** Thread and draft IDs whose reads in a batch always fail with 403, which Mailroom does not try again. */
    this.readFails = new Set();
    /** Thread IDs whose next read in a batch fails with 403 for a rate limit, as Gmail gives some rate limits. */
    this.readRateLimitOnce = new Set();
    /** The time of each batch request, from Date.now(). */
    this.batchTimes = [];
    /** When true, the next batch rejects the token of every call, as Gmail does for an expired token. */
    this.rejectTokenOnce = false;
  }

  matches(q) {
    const newer = /^newer_than:(\d+)d$/.exec(q);
    if (newer) {
      const limit = Date.now() - Number(newer[1]) * 86_400_000;
      return [...this.threads].filter(([, t]) => !t.trashed && Date.parse(t.date ?? DEFAULT_DATE) > limit).map(([id]) => id);
    }
    const unread = /^\((.*)\) is:unread$/.exec(q);
    if (unread) return this.matches(unread[1]).filter((id) => this.threads.get(id).labels.has("UNREAD"));
    const m = /^subject:"(.+)"$/.exec(q);
    // Like Gmail search, the fake leaves out trashed threads.
    return [...this.threads].filter(([, t]) => !t.trashed && (m ? t.subject === m[1] : true)).map(([id]) => id);
  }

  modify(id, body) {
    const t = this.threads.get(id);
    if (!t) return [404, { error: { code: 404, message: "Requested entity was not found." } }];
    if (this.rateLimitOnce.delete(id)) return [429, { error: { code: 429, message: "User-rate limit exceeded." } }];
    for (const l of body.addLabelIds ?? []) t.labels.add(l);
    for (const l of body.removeLabelIds ?? []) t.labels.delete(l);
    return [200, { id, messages: [] }];
  }

  /**
   * Returns the messages of a thread. The first message has the ID `${threadId}-m1`, the labels of the thread and its
   * `trashed` flag. Each item of `replies` is one more message, with its own ID, labels and `trashed` flag.
   */
  messagesOf(id) {
    const t = this.threads.get(id);
    return [{ id: `${id}-m1`, item: t }, ...(t.replies ?? []).map((r) => ({ id: r.id, item: r }))];
  }

  read(id) {
    const t = this.threads.get(id);
    if (!t) return [404, { error: { code: 404, message: "Requested entity was not found." } }];
    const headers = [
      { name: "From", value: t.from ?? "Monitor <monitor@example.com>" },
      { name: "Subject", value: t.subject },
      { name: "Date", value: t.date ?? DEFAULT_DATE },
      ...(t.list ? [{ name: "List-Id", value: t.list }] : []),
    ];
    const messages = this.messagesOf(id).map((m) => ({
      id: m.id,
      threadId: id,
      labelIds: [...m.item.labels, ...(m.item.trashed ? ["TRASH"] : [])],
      payload: { headers },
    }));
    return [200, { id, messages }];
  }

  /** Changes the labels of messages, as messages.batchModify does. The TRASH label sets the `trashed` flag of a message. */
  batchModify(body) {
    this.modifyRequests.push(body);
    if (this.refuseModify) return [this.refuseModify.code, { error: this.refuseModify }];
    const byId = new Map([...this.threads.keys()].flatMap((tid) => this.messagesOf(tid).map((m) => [m.id, { ...m, threadId: tid }])));
    if (body.ids.some((id) => !byId.has(id))) return [400, { error: { code: 400, message: "Invalid id value" } }];
    const limited = body.ids.filter((id) => this.rateLimitOnce.delete(byId.get(id).threadId));
    if (limited.length) return [429, { error: { code: 429, message: "User-rate limit exceeded." } }];
    for (const id of body.ids) {
      const { item } = byId.get(id);
      for (const l of body.addLabelIds ?? []) l === "TRASH" ? (item.trashed = true) : item.labels.add(l);
      for (const l of body.removeLabelIds ?? []) l === "TRASH" ? (item.trashed = false) : item.labels.delete(l);
    }
    return [204, null];
  }

  async fetch(input, init = {}) {
    this.requests++;
    const url = new URL(input instanceof URL || typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    if (url.href === "https://oauth2.googleapis.com/token") {
      this.tokenRequests++;
      const token = `token-${++this.tokens}`;
      this.issued.add(`Bearer ${token}`);
      return Response.json({ access_token: token, expires_in: 3600 });
    }
    const auth = new Headers(init.headers).get("Authorization");
    if (url.href === "https://gmail.googleapis.com/batch/gmail/v1") return this.batch(init, auth);
    if (!this.issued.has(auth)) return Response.json({ error: { code: 401, message: "bad token" } }, { status: 401 });
    if (url.pathname === "/calendar/v3/calendars/primary/events" && method === "GET") {
      this.eventQueries.push(Object.fromEntries(url.searchParams));
      if (this.eventsGone) return Response.json({ error: { code: 410, message: "The requested minimum modification time lies too far in the past." } }, { status: 410 });
      return Response.json({ timeZone: "Pacific/Auckland", items: this.events });
    }
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/labels" && method === "GET") return Response.json({ labels: this.labels });
    if (path === "/labels" && method === "POST") {
      const { name } = JSON.parse(init.body);
      const label = { id: `Label_${this.labels.length + 1}`, name, type: "user" };
      this.labels.push(label);
      return Response.json(label);
    }
    if (path === "/threads" && method === "GET") {
      this.searches.push(url.searchParams.get("q"));
      const all = this.matches(url.searchParams.get("q"));
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return Response.json({ threads: page.map((id) => ({ id })), ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === "/drafts" && method === "GET") return Response.json({ drafts: [...this.drafts.keys()].map((id) => ({ id })) });
    const draft = /^\/drafts\/([^/]+)$/.exec(path);
    if (draft && method === "DELETE") {
      this.drafts.delete(decodeURIComponent(draft[1]));
      return new Response(null, { status: 204 });
    }
    if (draft && method === "GET") {
      const [status, body] = this.draft(decodeURIComponent(draft[1]));
      return Response.json(body, { status });
    }
    const upload = /^\/upload\/drafts\/([^/]+)$/.exec(path);
    if (upload && method === "PUT") {
      const id = decodeURIComponent(upload[1]);
      const boundary = /boundary=(\S+)/.exec(new Headers(init.headers).get("Content-Type"))[1];
      const [metadata, message] = init.body.split(`--${boundary}`).slice(1, 3).map((p) => p.slice(p.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, ""));
      this.uploads.push({ id, metadata: JSON.parse(metadata), message });
      return Response.json({ id, message: { id: `${id}-m2`, threadId: this.drafts.get(id).threadId } });
    }
    if (path === "/drafts/send" && method === "POST") {
      const { id } = JSON.parse(init.body);
      this.sent.push(id);
      return Response.json({ id: `${id}-sent`, threadId: this.drafts.get(id).threadId });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread && method === "GET") {
      const id = decodeURIComponent(thread[1]);
      return Response.json({ id, messages: this.mailThreads.get(id).map((_, i) => this.mailMessage(id, i)) });
    }
    const attachment = /^\/messages\/[^/]+\/attachments\/([^/]+)$/.exec(path);
    if (attachment && method === "GET") return Response.json({ data: this.attachments.get(decodeURIComponent(attachment[1])) });
    const message = /^\/messages\/([^/]+)-(\d+)$/.exec(path);
    if (message && method === "GET") {
      const id = decodeURIComponent(message[1]);
      if (!this.mailThreads.get(id)?.[Number(message[2])]) {
        return Response.json({ error: { code: 404, message: "Requested entity was not found." } }, { status: 404 });
      }
      return Response.json(this.mailMessage(id, Number(message[2])));
    }
    if (path === "/messages/batchModify" && method === "POST") {
      const [status, body] = this.batchModify(JSON.parse(init.body));
      return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
    }
    const m = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (m && method === "POST") {
      const [status, body] = this.modify(decodeURIComponent(m[1]), JSON.parse(init.body));
      return Response.json(body, { status });
    }
    throw new Error(`The fake Gmail has no route for ${method} ${url.href}`);
  }

  /** Returns the status and the JSON of a draft, as Gmail gives it. */
  draft(id) {
    const d = this.drafts.get(id);
    if (!d) return [404, { error: { code: 404, message: "Requested entity was not found." } }];
    const body = d.body === undefined ? {} : { mimeType: "text/plain", body: { data: Buffer.from(d.body).toString("base64url") } };
    return [200, { id, message: { id: `${id}-m`, threadId: d.threadId, labelIds: ["DRAFT"], snippet: d.body, payload: { headers: d.headers, ...body } } }];
  }

  /** Returns message `i` of a thread for send_draft and get_thread, as Gmail gives it. */
  mailMessage(threadId, i) {
    const msg = this.mailThreads.get(threadId)[i];
    const body = msg.body === undefined ? {} : { mimeType: "text/plain", body: { data: Buffer.from(msg.body).toString("base64url") } };
    return { id: `${threadId}-${i}`, threadId, labelIds: msg.labels, payload: { headers: msg.headers, ...(msg.payload ?? body) } };
  }

  /** Answers a batch request in the format of the real Gmail, with CRLF line ends. */
  batch(init, auth) {
    const boundary = /boundary=(\S+)/.exec(new Headers(init.headers).get("Content-Type"))[1];
    const calls = init.body
      .split(`--${boundary}`)
      .filter((p) => p.includes("HTTP/1.1"))
      .map((p) => {
        const id = /Content-ID: <(item\d+)>/.exec(p)[1];
        const [, method, path] = /^(\w+) (\S+) HTTP\/1\.1$/m.exec(p);
        const bodyAt = p.indexOf("{");
        return { id, method, path, body: bodyAt >= 0 ? JSON.parse(p.slice(bodyAt).trim()) : undefined };
      });
    // Mailroom sends only reads in batches. It changes messages with messages.batchModify.
    assert.ok(calls.every((c) => c.method === "GET"), "a batch has only reads");
    this.batches.push(`read:${calls.length}`);
    this.batchTimes.push(Date.now());
    const rejectToken = this.rejectTokenOnce || !this.issued.has(auth);
    this.rejectTokenOnce = false;
    const out = "batch_FAKE";
    const parts = calls.map((c) => {
      let status;
      let body;
      if (rejectToken) {
        [status, body] = [401, { error: { code: 401, message: "Request had invalid authentication credentials." } }];
      } else {
        const read = /^\/gmail\/v1\/users\/me\/threads\/([^/?]+)\?format=metadata&/.exec(c.path);
        const draft = /^\/gmail\/v1\/users\/me\/drafts\/([^/?]+)\?format=metadata$/.exec(c.path);
        const readId = decodeURIComponent((read ?? draft)?.[1] ?? "");
        if (c.method === "GET" && this.readFails.has(readId)) {
          [status, body] = [403, { error: { code: 403, message: "The read failed." } }];
        } else if (c.method === "GET" && this.readRateLimitOnce.delete(readId)) {
          const errors = [{ domain: "usageLimits", reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded" }];
          [status, body] = [403, { error: { code: 403, message: "User Rate Limit Exceeded", errors } }];
        } else if (read && c.method === "GET") {
          [status, body] = this.read(readId);
        } else {
          assert.ok(draft, `unexpected batch call ${c.method} ${c.path}`);
          [status, body] = this.draft(readId);
        }
      }
      return [
        `--${out}`,
        "Content-Type: application/http",
        `Content-ID: <response-${c.id}>`,
        "",
        `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}`,
        "Content-Type: application/json; charset=UTF-8",
        "Vary: Origin",
        "",
        JSON.stringify(body, null, 2),
        "",
      ].join("\r\n");
    });
    // Gmail does not keep the order of the calls in its answer.
    parts.reverse();
    return new Response(`\r\n${parts.join("")}--${out}--\r\n`, {
      status: 200,
      headers: { "Content-Type": `multipart/mixed; boundary=${out}` },
    });
  }

  labelId(name) {
    return this.labels.find((l) => l.name === name)?.id;
  }
}

let gmail;
let calls;
let client;
/** The documents that the fake Workers AI converted, and its next result. */
let conversions;
let conversionResult;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  gmail = new FakeGmail(60);
  globalThis.fetch = (input, init) => gmail.fetch(input, init);
  calls = [];
  conversions = [];
  conversionResult = { format: "markdown", data: "# Invoice\n\nTotal: $120, due 2026-12-01" };
  const AI = {
    async toMarkdown(doc, options) {
      conversions.push({ name: doc.name, type: doc.blob.type, text: await doc.blob.text(), options });
      return { id: "1", name: doc.name, mimeType: doc.blob.type, ...conversionResult };
    },
  };
  // The tests do not wait between Gmail batch requests.
  const env = { APP_NAME: "Mailroom", AI, GMAIL_BATCH_INTERVAL_MS: 0 };
  const { version } = await mod.toolCatalog(env);
  client = await connect(env, version);
});

/** Returns a client of a new server with the tools of the test user, with `env` and the tool list of version `version`. */
async function connect(env, version) {
  const caller = { props: { userId: "user-1", email: "me@example.com" }, clientId: null };
  const server = mod.buildServer(env, caller, "https://mailroom.test", (c) => calls.push(c), version);
  const [a, b] = mod.InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new mod.Client({ name: "test", version: "1" });
  await c.connect(b);
  return c;
}

after(() => {
  globalThis.fetch = realFetch;
});

/** Calls a tool and returns its JSON result, or its error text with isError. */
async function call(name, args) {
  const res = await client.callTool({ name, arguments: { account: "me@example.com", ...args } });
  const t = res.content[0].text;
  if (res.isError) return { isError: true, text: t };
  return JSON.parse(t);
}

/** Gets the preview of a bulk tool, checks that it changed nothing, and returns it. */
async function preview(name, args) {
  const before = JSON.stringify([...gmail.threads].map(([id, t]) => [id, [...t.labels], !!t.trashed]));
  const labels = gmail.labels.length;
  const p = await call(name, args);
  assert.ok(!p.isError, p.text);
  assert.equal(JSON.stringify([...gmail.threads].map(([id, t]) => [id, [...t.labels], !!t.trashed])), before, "a preview changes nothing");
  assert.equal(gmail.labels.length, labels, "a preview creates no label");
  return p;
}

/** Gets the preview of a bulk tool and confirms it. Returns the result of the confirmation. */
async function previewAndConfirm(name, args) {
  const p = await preview(name, args);
  return call(name, { ...args, confirmation_token: p.confirmation_token });
}

const failures = 'subject:"PopularityService failure"';
const kinds = (kind) => gmail.batches.filter((b) => b.startsWith(`${kind}:`)).map((b) => Number(b.split(":")[1]));

/** Returns Gmail headers from an object of names and values. */
const headers = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

describe("preview", () => {
  test("groups the threads by sender, and does not count as a change", async () => {
    gmail.threads.set("x1", { labels: new Set(["INBOX"]), subject: "Hello", from: "Ana <ana@example.com>", date: "Wed, 11 Nov 2026 09:00:00 +1300" });
    for (const [i, subject] of ["One", "Two", "Three", "Four"].entries()) {
      gmail.threads.set(`y${i}`, { labels: new Set(["INBOX"]), subject, from: "news@example.com" });
    }
    const p = await preview("modify_labels_by_query", { query: "in:inbox", add: ["Ops"], remove: ["INBOX"] });
    assert.equal(p.preview, true);
    assert.equal(p.thread_count, 65);
    assert.equal(p.threads, undefined);
    assert.deepEqual(p.senders, [
      {
        from: "Monitor <monitor@example.com>",
        threads: 60,
        newest: "2026-11-09T20:00:00Z",
        oldest: "2026-11-09T20:00:00Z",
        subjects: ["PopularityService failure", "Lunch"],
      },
      { from: "news@example.com", threads: 4, newest: "2026-11-09T20:00:00Z", oldest: "2026-11-09T20:00:00Z", subjects: ["One", "Two", "Three"], other_subjects: 1 },
      { from: "Ana <ana@example.com>", threads: 1, newest: "2026-11-10T20:00:00Z", oldest: "2026-11-10T20:00:00Z", subjects: ["Hello"] },
    ]);
    assert.ok(p.confirmation_token.length > 20);
    assert.ok(Date.parse(p.expires_at) > Date.now());
    assert.deepEqual(kinds("read"), [25, 25, 15]);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: false }]);
  });

  test("gives only the number of threads of each sender on request", async () => {
    gmail.threads.set("x1", { labels: new Set(["INBOX"]), subject: "Hello", from: "Ana <Ana@Example.com>" });
    for (const i of [0, 1, 2]) gmail.threads.set(`y${i}`, { labels: new Set(["INBOX"]), subject: `News ${i}`, from: "news@example.com" });
    const p = await preview("modify_labels_by_query", { query: "in:inbox", remove: ["INBOX"], preview_detail: "senders" });
    assert.equal(p.preview_detail, "senders");
    assert.equal(p.senders, undefined);
    assert.equal(JSON.stringify(p.threads_by_sender), JSON.stringify({ "monitor@example.com": 60, "news@example.com": 3, "ana@example.com": 1 }));
    assert.doesNotMatch(p.note, /characters/);
  });

  test("gives only the number of threads of each sender when the preview is long", async () => {
    for (let i = 0; i < 200; i++) {
      gmail.threads.set(`z${i}`, { labels: new Set(["INBOX"]), subject: `Your weekly digest number ${i} from the store`, from: `Store ${i} <store${i}@example.com>` });
    }
    for (const preview_detail of ["grouped", "full"]) {
      const p = await preview("trash_threads_by_query", { query: "in:inbox", max_threads: 500, preview_detail });
      assert.equal(p.thread_count, 260);
      assert.equal(p.preview_detail, "senders");
      assert.equal(p.senders, undefined);
      assert.equal(p.threads, undefined);
      assert.equal(Object.keys(p.threads_by_sender).length, 201);
      assert.equal(p.threads_by_sender["store7@example.com"], 1);
      assert.match(p.note, new RegExp(`The ${preview_detail} preview is longer than 20000 characters`));
    }
  });

  test("does not repeat the list of threads", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const p = await preview("modify_threads_labels", { thread_ids: ids, add: ["Existing"] });
    assert.equal(p.thread_ids, undefined);
    assert.equal(p.preview_detail, "grouped");
    const r = await call("modify_threads_labels", { thread_ids: ids, add: ["Existing"], confirmation_token: p.confirmation_token });
    assert.equal(r.changed, 30);
    assert.equal(r.thread_ids, undefined);
  });

  test("shows the sender, subject and date of each thread on request", async () => {
    const p = await preview("modify_labels_by_query", { query: failures, add: ["Ops"], remove: ["INBOX"], preview_detail: "full" });
    assert.equal(p.thread_count, 30);
    assert.deepEqual(p.threads[0], {
      thread_id: "t0",
      from: "Monitor <monitor@example.com>",
      subject: "PopularityService failure",
      date: "2026-11-09T20:00:00Z",
      message_count: 1,
    });
    assert.ok(p.threads.every((t) => t.subject === "PopularityService failure"));
    assert.deepEqual(kinds("read"), [25, 5]);
  });

  test("a confirmation changes exactly the threads of the preview, also when the search matches more by then", async () => {
    const p = await preview("modify_labels_by_query", { query: failures, add: ["Ops"] });
    gmail.threads.set("late", { labels: new Set(["INBOX"]), subject: "PopularityService failure" });
    const r = await call("modify_labels_by_query", { query: failures, add: ["Ops"], confirmation_token: p.confirmation_token });
    assert.equal(r.confirmed, true);
    assert.equal(r.changed, 30);
    assert.ok(!gmail.threads.get("late").labels.has(gmail.labelId("Ops")));
  });

  test("a token works once", async () => {
    const p = await preview("trash_threads", { thread_ids: ["t1"] });
    assert.equal((await call("trash_threads", { thread_ids: ["t1"], confirmation_token: p.confirmation_token })).trashed, 1);
    const again = await call("trash_threads", { thread_ids: ["t1"], confirmation_token: p.confirmation_token });
    assert.match(again.text, /does not work for this call/);
  });

  test("a token does not work for other arguments or another tool", async () => {
    const p = await preview("modify_labels_by_query", { query: failures, add: ["Ops"] });
    const t = p.confirmation_token;
    for (const [name, args] of [
      ["modify_labels_by_query", { query: failures, add: ["Other"] }],
      ["modify_labels_by_query", { query: "in:inbox", add: ["Ops"] }],
      ["modify_labels_by_query", { query: failures, add: ["Ops"], remove: ["INBOX"] }],
      ["trash_threads_by_query", { query: failures }],
    ]) {
      const r = await call(name, { ...args, confirmation_token: t });
      assert.match(r.text, /does not work for this call/, `${name} ${JSON.stringify(args)}`);
    }
    assert.ok([...gmail.threads.values()].every((x) => !x.trashed && x.labels.size === 1));
    assert.deepEqual(gmail.modifyRequests, []);
  });

  test("an invented token changes nothing", async () => {
    const r = await call("trash_threads_by_query", { query: failures, confirmation_token: "made-up" });
    assert.match(r.text, /does not work for this call/);
    assert.ok([...gmail.threads.values()].every((t) => !t.trashed));
  });

  test("a search with no matches gives no token", async () => {
    const p = await preview("trash_threads_by_query", { query: 'subject:"nothing"' });
    assert.equal(p.thread_count, 0);
    assert.equal(p.confirmation_token, undefined);
  });

  test("a list with unknown threads previews only the threads that exist", async () => {
    const p = await preview("trash_threads", { thread_ids: ["t1", "nope", "t1"], preview_detail: "full" });
    assert.deepEqual(p.threads.map((t) => t.thread_id), ["t1"]);
    assert.deepEqual(p.not_found, ["nope"]);
    const r = await call("trash_threads", { thread_ids: ["nope", "t1"], confirmation_token: p.confirmation_token });
    assert.equal(r.threads, 1);
    assert.equal(r.trashed, 1);
  });
});

describe("modify_labels_by_query", () => {
  test("changes every matching thread in one request, and creates a missing label", async () => {
    const r = await previewAndConfirm("modify_labels_by_query", { query: failures, add: ["Ops/PopularityService"], remove: ["INBOX"] });
    assert.equal(r.threads, 30);
    assert.equal(r.changed, 30);
    assert.deepEqual(r.failed, []);
    const id = gmail.labelId("Ops/PopularityService");
    assert.ok(id, "the tool created the label");
    for (const [tid, t] of gmail.threads) {
      const failure = t.subject === "PopularityService failure";
      assert.equal(t.labels.has(id), failure, `${tid} label`);
      assert.equal(t.labels.has("INBOX"), !failure, `${tid} inbox`);
    }
    assert.deepEqual(gmail.modifyRequests.map((r) => r.ids.length), [30]);
    assert.deepEqual(calls, [
      { accountId: "acct-1", change: false },
      { accountId: "acct-1", change: true },
    ]);
  });

  test("previews at most 100 threads unless max_threads says otherwise, and reports more_matches", async () => {
    gmail = new FakeGmail(700);
    const p = await preview("modify_labels_by_query", { query: "in:inbox", add: ["Existing"] });
    assert.equal(p.thread_count, 100);
    assert.equal(p.more_matches, true);
    const big = await preview("modify_labels_by_query", { query: "in:inbox", add: ["Existing"], max_threads: 500 });
    assert.equal(big.thread_count, 500);
    const r = await call("modify_labels_by_query", { query: "in:inbox", add: ["Existing"], confirmation_token: big.confirmation_token });
    assert.equal(r.changed, 500);
    assert.deepEqual(gmail.modifyRequests.map((r) => r.ids.length), [500]);
  });

  test("rejects an empty search, forbidden labels and an empty change, before it reads mail", async () => {
    assert.ok((await call("modify_labels_by_query", { query: "  ", add: ["X"] })).isError);
    assert.match((await call("modify_labels_by_query", { query: "in:inbox", add: ["Trash"] })).text, /cannot add or remove these labels: Trash/);
    assert.match((await call("modify_labels_by_query", { query: "in:inbox" })).text, /at least one label/);
    assert.deepEqual(gmail.batches, []);
  });
});

describe("modify_threads_labels", () => {
  test("changes each thread, and tries a rate-limited request again", async () => {
    const p = await preview("modify_threads_labels", { thread_ids: ["t1", "t3", "t7"], add: ["STARRED"], remove: ["INBOX"] });
    gmail.rateLimitOnce = new Set(["t3", "t7"]);
    const r = await call("modify_threads_labels", {
      thread_ids: ["t7", "t3", "t1"],
      add: ["STARRED"],
      remove: ["INBOX"],
      confirmation_token: p.confirmation_token,
    });
    assert.equal(r.changed, 3);
    assert.deepEqual(r.failed, []);
    for (const id of ["t1", "t3", "t7"]) {
      assert.ok(gmail.threads.get(id).labels.has("STARRED"));
      assert.ok(!gmail.threads.get(id).labels.has("INBOX"));
    }
    assert.deepEqual(gmail.modifyRequests.map((r) => r.ids.length), [3, 3]);
  });

  test("a token does not work for another list of threads", async () => {
    const p = await preview("modify_threads_labels", { thread_ids: ["t1"], add: ["Existing"] });
    const r = await call("modify_threads_labels", { thread_ids: ["t1", "t2"], add: ["Existing"], confirmation_token: p.confirmation_token });
    assert.match(r.text, /does not work for this call/);
  });

  test("gets a new token when Gmail rejects the token inside a batch", async () => {
    await preview("modify_threads_labels", { thread_ids: ["t2", "t4"], add: ["Existing"] });
    const before = gmail.tokenRequests;
    gmail.rejectTokenOnce = true;
    const p = await preview("modify_threads_labels", { thread_ids: ["t2", "t4"], add: ["Existing"], preview_detail: "full" });
    assert.deepEqual(p.threads.map((t) => t.thread_id), ["t2", "t4"]);
    assert.equal(p.not_read, undefined);
    assert.equal(gmail.tokenRequests, before + 1);
  });

  test("reports a label to remove that does not exist", async () => {
    const r = await previewAndConfirm("modify_threads_labels", { thread_ids: ["t1"], remove: ["Missing"] });
    assert.deepEqual(r.labels_not_found, ["Missing"]);
  });
});

describe("trash_threads_by_query", () => {
  test("trashes every matching thread, and then the search matches none", async () => {
    const r = await previewAndConfirm("trash_threads_by_query", { query: failures });
    assert.equal(r.trashed, 30);
    assert.deepEqual(r.failed, []);
    for (const t of gmail.threads.values()) assert.equal(!!t.trashed, t.subject === "PopularityService failure");
    assert.deepEqual(gmail.modifyRequests.map((r) => [r.ids.length, r.addLabelIds]), [[30, ["TRASH"]]]);
    const again = await preview("trash_threads_by_query", { query: failures });
    assert.equal(again.thread_count, 0);
  });

  test("continues where the previous confirmation stopped", async () => {
    const first = await previewAndConfirm("trash_threads_by_query", { query: "in:inbox", max_threads: 40 });
    assert.equal(first.trashed, 40);
    const second = await previewAndConfirm("trash_threads_by_query", { query: "in:inbox", max_threads: 40 });
    assert.equal(second.trashed, 20);
    assert.ok([...gmail.threads.values()].every((t) => t.trashed));
  });

  test("rejects an empty search", async () => {
    assert.ok((await call("trash_threads_by_query", { query: "" })).isError);
  });
});

describe("Gmail rate limits", () => {
  test("a read gets another try after a rate limit with the status 403", async () => {
    gmail.readRateLimitOnce.add("t3");
    const p = await preview("trash_threads_by_query", { query: 'subject:"Lunch"', max_threads: 2, preview_detail: "full" });
    assert.deepEqual(p.threads.map((t) => t.thread_id), ["t1", "t3"]);
    assert.equal(p.not_read, undefined);
    assert.deepEqual(kinds("read"), [2, 1]);
  });

  test("one call sends its batch requests with the interval between them", async () => {
    const paced = await connect({ APP_NAME: "Mailroom", GMAIL_BATCH_INTERVAL_MS: 100 }, "test");
    const res = await paced.callTool({ name: "trash_threads_by_query", arguments: { account: "me@example.com", query: "in:inbox" } });
    assert.equal(JSON.parse(res.content[0].text).thread_count, 60);
    const gaps = gmail.batchTimes.slice(1).map((t, i) => t - gmail.batchTimes[i]);
    assert.equal(gaps.length, 2);
    assert.ok(gaps.every((g) => g >= 95), `the gaps were ${gaps}`);
  });
});

describe("safeguards", () => {
  const old = "Mon, 01 Jun 2026 09:00:00 +1200";
  const recent = () => new Date(Date.now() - 3600_000).toUTCString();

  beforeEach(() => {
    gmail = new FakeGmail(0);
    const add = (id, labels, date = old) => gmail.threads.set(id, { labels: new Set(["INBOX", ...labels]), subject: "Report", date });
    add("seen", []);
    add("unread", ["UNREAD"]);
    add("new", [], recent());
    add("starred", ["STARRED"]);
    add("sent", ["SENT"]);
  });

  /** Returns the IDs of the threads in a full preview, and the counts of the threads that the safeguards left out. */
  const kept = async (name, args) => {
    const p = await preview(name, { query: "in:inbox", preview_detail: "full", ...args });
    return { ids: (p.threads ?? []).map((t) => t.thread_id).sort(), left_out: p.left_out };
  };

  test("the label tools leave out nothing unless the call asks", async () => {
    assert.deepEqual(await kept("modify_labels_by_query", { add: ["Existing"] }), {
      ids: ["new", "seen", "sent", "starred", "unread"],
      left_out: undefined,
    });
  });

  test("older_than_days and seen_only leave out new and unread threads", async () => {
    assert.deepEqual(await kept("modify_labels_by_query", { add: ["Existing"], older_than_days: 1, seen_only: true }), {
      ids: ["seen", "sent", "starred"],
      left_out: { newer: 1, unread: 1 },
    });
  });

  test("older_than_days leaves out threads with a newer message without reading them, and goes on to later results", async () => {
    gmail = new FakeGmail(0);
    // Gmail lists the threads with the newest messages first.
    for (let i = 0; i < 600; i++) gmail.threads.set(`r${i}`, { labels: new Set(["INBOX"]), subject: "Active", date: recent() });
    for (let i = 0; i < 20; i++) gmail.threads.set(`o${i}`, { labels: new Set(["INBOX"]), subject: "Report", date: old });
    const p = await preview("trash_threads_by_query", { query: "in:inbox", older_than_days: 1, max_threads: 10, preview_detail: "full" });
    assert.deepEqual(
      p.threads.map((t) => t.thread_id),
      Array.from({ length: 10 }, (_, i) => `o${i}`),
    );
    assert.deepEqual(p.left_out, { newer: 600 });
    assert.equal(p.more_matches, true);
    assert.deepEqual(kinds("read"), [10]);
    assert.deepEqual(gmail.searches, ["newer_than:1d", "newer_than:1d", "in:inbox", "in:inbox"]);
    const r = await call("trash_threads_by_query", { query: "in:inbox", older_than_days: 1, confirmation_token: p.confirmation_token });
    assert.equal(r.trashed, 10);
    assert.ok(!gmail.threads.get("r0").trashed && gmail.threads.get("o9").trashed && !gmail.threads.get("o10").trashed);
  });

  test("older_than_days leaves out listed threads with a newer message without reading them", async () => {
    const p = await preview("trash_threads", { thread_ids: ["new", "seen"], older_than_days: 1, preview_detail: "full" });
    assert.deepEqual(p.threads.map((t) => t.thread_id), ["seen"]);
    assert.deepEqual(p.left_out, { newer: 1 });
    assert.deepEqual(kinds("read"), [1]);
  });

  test("by default, the trash tools leave out starred threads and threads with a sent message", async () => {
    assert.deepEqual(await kept("trash_threads_by_query", {}), { ids: ["new", "seen", "unread"], left_out: { starred: 1, sent: 1 } });
    const p = await preview("trash_threads", { thread_ids: ["starred", "seen"], preview_detail: "full" });
    assert.deepEqual(p.threads.map((t) => t.thread_id), ["seen"]);
  });

  test("include_protected trashes those threads too, and a confirmation must repeat it", async () => {
    assert.deepEqual(await kept("trash_threads_by_query", { include_protected: true }), {
      ids: ["new", "seen", "sent", "starred", "unread"],
      left_out: undefined,
    });
    const args = { thread_ids: ["starred", "sent"], include_protected: true };
    const p = await preview("trash_threads", args);
    const without = await call("trash_threads", { thread_ids: args.thread_ids, confirmation_token: p.confirmation_token });
    assert.match(without.text, /does not work for this call/);
    assert.equal((await call("trash_threads", { ...args, confirmation_token: p.confirmation_token })).trashed, 2);
  });

  test("only the trash tools have include_protected", async () => {
    const { tools } = await client.listTools();
    const has = (name) => "include_protected" in tools.find((t) => t.name === name).inputSchema.properties;
    assert.deepEqual(["trash_threads", "trash_threads_by_query", "modify_threads_labels", "modify_labels_by_query"].map(has), [true, true, false, false]);
  });

  test("a confirmation must repeat the safeguards", async () => {
    const p = await preview("trash_threads_by_query", { query: "in:inbox", seen_only: true });
    const r = await call("trash_threads_by_query", { query: "in:inbox", confirmation_token: p.confirmation_token });
    assert.match(r.text, /does not work for this call/);
    const ok = await call("trash_threads_by_query", { query: "in:inbox", seen_only: true, confirmation_token: p.confirmation_token });
    assert.equal(ok.trashed, 2);
    assert.deepEqual([...gmail.threads].filter(([, t]) => t.trashed).map(([id]) => id).sort(), ["new", "seen"]);
  });
});

describe("trash_threads", () => {
  test("trashes each thread and tries a rate-limited request again", async () => {
    const p = await preview("trash_threads", { thread_ids: ["t1", "t2"] });
    gmail.rateLimitOnce = new Set(["t2"]);
    const r = await call("trash_threads", { thread_ids: ["t1", "t2"], confirmation_token: p.confirmation_token });
    assert.equal(r.trashed, 2);
    assert.ok(gmail.threads.get("t1").trashed && gmail.threads.get("t2").trashed);
    assert.ok(!gmail.threads.get("t3").trashed);
  });
});

describe("the messages of a preview", () => {
  test("a reply that arrives after the preview stays in the inbox, after a trash and after an archive", async () => {
    const trash = await preview("trash_threads", { thread_ids: ["t0"] });
    const archive = await preview("modify_threads_labels", { thread_ids: ["t1"], remove: ["INBOX"] });
    for (const id of ["t0", "t1"]) gmail.threads.get(id).replies = [{ id: `${id}-r1`, labels: new Set(["INBOX", "UNREAD"]) }];
    assert.equal((await call("trash_threads", { thread_ids: ["t0"], confirmation_token: trash.confirmation_token })).trashed, 1);
    const archived = await call("modify_threads_labels", { thread_ids: ["t1"], remove: ["INBOX"], confirmation_token: archive.confirmation_token });
    assert.equal(archived.changed, 1);
    const [t0, t1] = [gmail.threads.get("t0"), gmail.threads.get("t1")];
    assert.ok(t0.trashed && !t0.replies[0].trashed);
    assert.ok(!t1.labels.has("INBOX") && t1.replies[0].labels.has("INBOX"));
    assert.deepEqual(gmail.modifyRequests.map((r) => r.ids), [["t0-m1"], ["t1-m1"]]);
  });

  test("never changes drafts, and leaves out a thread with only drafts", async () => {
    gmail.threads.get("t0").replies = [{ id: "t0-d1", labels: new Set(["DRAFT"]) }];
    gmail.threads.get("t2").labels = new Set(["DRAFT"]);
    const p = await preview("trash_threads", { thread_ids: ["t0", "t2"], preview_detail: "full" });
    assert.deepEqual(p.threads.map((t) => t.thread_id), ["t0"]);
    assert.deepEqual(p.left_out, { drafts: 1 });
    assert.equal((await call("trash_threads", { thread_ids: ["t0", "t2"], confirmation_token: p.confirmation_token })).trashed, 1);
    assert.deepEqual(gmail.modifyRequests.map((r) => r.ids), [["t0-m1"]]);
    assert.ok(!gmail.threads.get("t0").replies[0].trashed);
  });

  test("sends at most 1000 messages in each request, and counts a thread in two requests once", async () => {
    gmail = new FakeGmail(500);
    for (const [id, t] of gmail.threads) t.replies = [1, 2].map((n) => ({ id: `${id}-r${n}`, labels: new Set(["INBOX"]) }));
    const r = await previewAndConfirm("modify_labels_by_query", { query: "in:inbox", remove: ["INBOX"], max_threads: 500 });
    assert.equal(r.changed, 500);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(gmail.modifyRequests.map((x) => x.ids.length), [1000, 500]);
    assert.ok([...gmail.threads.values()].every((t) => !t.labels.has("INBOX") && t.replies.every((m) => !m.labels.has("INBOX"))));
  });

  test("when Gmail refuses a request, each thread in it fails with the error", async () => {
    const p = await preview("trash_threads", { thread_ids: ["t1", "t2"] });
    gmail.refuseModify = { code: 400, message: "Invalid id value" };
    const r = await call("trash_threads", { thread_ids: ["t1", "t2"], confirmation_token: p.confirmation_token });
    assert.equal(r.trashed, 0);
    assert.deepEqual(r.failed, [
      { thread_id: "t1", error: "Invalid id value" },
      { thread_id: "t2", error: "Invalid id value" },
    ]);
    assert.equal(gmail.modifyRequests.length, 1);
  });
});

describe("search_threads", () => {
  test("gives compact rows, and reads the threads in batches", async () => {
    gmail.threads.get("t0").labels.add("UNREAD");
    const r = await call("search_threads", { query: "in:inbox", max_results: 50 });
    assert.equal(r.threads.length, 50);
    assert.deepEqual(r.threads[0], {
      thread_id: "t0",
      from: "Monitor <monitor@example.com>",
      subject: "PopularityService failure",
      date: "2026-11-09T20:00:00Z",
      snippet: null,
      labels: ["INBOX", "UNREAD"],
      unread: true,
      messages: 1,
    });
    assert.equal(r.threads[1].unread, false);
    assert.equal(r.next_page_token, "50");
    assert.deepEqual(kinds("read"), [25, 25]);
  });

  test("gives the threads that Gmail read, and the threads that it did not read", async () => {
    gmail.readFails.add("t2");
    const r = await call("search_threads", { query: failures, max_results: 3 });
    assert.deepEqual(r.threads.map((t) => t.thread_id), ["t0", "t4"]);
    assert.deepEqual(r.not_read, [{ thread_id: "t2", error: "The read failed." }]);
    assert.match(r.note, /To try again, call search_threads again/);
  });

  test("gives no note when Gmail read every thread", async () => {
    const r = await call("search_threads", { query: failures, max_results: 3 });
    assert.equal(r.not_read, undefined);
    assert.equal(r.note, undefined);
  });

  test("gives full rows on request", async () => {
    const r = await call("search_threads", { query: failures, max_results: 1, detail: "full" });
    assert.deepEqual(r.threads[0], {
      thread_id: "t0",
      message_count: 1,
      participants: ["Monitor <monitor@example.com>"],
      latest: {
        message_id: "t0-m1",
        from: "Monitor <monitor@example.com>",
        date: "Tue, 10 Nov 2026 09:00:00 +1300",
        subject: "PopularityService failure",
        labels: ["INBOX"],
      },
      thread_labels: ["INBOX"],
    });
  });
});

describe("summarise_threads", () => {
  beforeEach(() => {
    gmail = new FakeGmail(0);
    const add = (id, t) => gmail.threads.set(id, { labels: new Set(["INBOX", ...(t.unread ? ["UNREAD"] : [])]), ...t });
    add("a1", { from: "GitHub <notifications@github.com>", subject: "[mailroom] Build #812 failed", list: "mailroom <mailroom.karlvr.github.com>", unread: true, date: "Wed, 11 Nov 2026 08:00:00 +1300" });
    add("a2", { from: "GitHub <notifications@github.com>", subject: "[mailroom] Build #813 failed", list: "mailroom <mailroom.karlvr.github.com>" });
    add("a3", { from: "noreply@github.com", subject: "Re: [mailroom] Build #814 failed", list: "<other.github.com>" });
    add("a4", { from: "Ana <ana@example.com>", subject: "Lunch on 2026-11-12?", unread: true });
  });

  test("gives only the counts without group_by", async () => {
    assert.deepEqual(await call("summarise_threads", {}), { account: "me@example.com", query: "in:inbox", total: 4, unread: 2 });
    assert.deepEqual(gmail.batches, []);
  });

  test("groups by sender, with samples of the subjects", async () => {
    const r = await call("summarise_threads", { group_by: "sender" });
    assert.equal(r.grouped_threads, 4);
    assert.deepEqual(r.groups, [
      { key: "notifications@github.com", threads: 2, unread: 1, latest: "2026-11-10T19:00:00Z", subjects: ["[mailroom] Build #812 failed", "[mailroom] Build #813 failed"] },
      { key: "noreply@github.com", threads: 1, unread: 0, latest: "2026-11-09T20:00:00Z", subjects: ["Re: [mailroom] Build #814 failed"] },
      { key: "ana@example.com", threads: 1, unread: 1, latest: "2026-11-09T20:00:00Z", subjects: ["Lunch on 2026-11-12?"] },
    ]);
  });

  test("groups by domain, list and subject pattern", async () => {
    const keys = async (group_by) => (await call("summarise_threads", { group_by })).groups.map((g) => [g.key, g.threads]);
    assert.deepEqual(await keys("domain"), [["github.com", 3], ["example.com", 1]]);
    assert.deepEqual(await keys("list"), [["mailroom.karlvr.github.com", 2], ["other.github.com", 1], [null, 1]]);
    assert.deepEqual(await keys("subject"), [["[mailroom] Build ## failed", 3], ["Lunch on #?", 1]]);
    const bySubject = await call("summarise_threads", { group_by: "subject" });
    assert.deepEqual(bySubject.groups[0].senders, ["GitHub <notifications@github.com>", "noreply@github.com"]);
  });

  test("counts the threads that Gmail did not read, and keeps the counts complete", async () => {
    gmail.readFails.add("a1");
    const r = await call("summarise_threads", { group_by: "sender" });
    assert.equal(r.total, 4);
    assert.equal(r.grouped_threads, 3);
    assert.equal(r.not_read, 1);
    assert.match(r.note, /To try again, call summarise_threads again/);
  });

  test("gets one access token, also when its requests run at the same time", async () => {
    await call("summarise_threads", { group_by: "sender" });
    assert.equal(gmail.tokenRequests, 1);
  });

  test("limits the groups and the threads that it groups", async () => {
    const r = await call("summarise_threads", { group_by: "sender", max_groups: 1, max_threads: 3 });
    assert.equal(r.total, 4);
    assert.equal(r.grouped_threads, 3);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups.map((g) => g.key), ["notifications@github.com"]);
    assert.deepEqual(r.other_groups, { groups: 1, threads: 1 });
  });
});

describe("tools for every account", () => {
  beforeEach(() => {
    gmail.threads.get("t2").date = "Wed, 11 Nov 2026 09:00:00 +1300";
    mod.OTHER_ACCOUNTS.push(
      { ...mod.TEST_ACCOUNT, id: "acct-2", email: "two@example.com" },
      { ...mod.TEST_ACCOUNT, id: "acct-3", email: "old@example.com", status: "relink" },
    );
  });
  afterEach(() => {
    mod.OTHER_ACCOUNTS.length = 0;
  });

  /** Calls a tool without an account, and returns its JSON result. */
  const callAll = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  test("search_all_accounts gives the newest threads of all accounts in one list", async () => {
    const r = await callAll("search_all_accounts", { query: failures, max_results: 2 });
    assert.deepEqual(
      r.threads.map((t) => [t.account, t.thread_id, t.date]),
      [
        ["me@example.com", "t2", "2026-11-10T20:00:00Z"],
        ["two@example.com", "t2", "2026-11-10T20:00:00Z"],
        ["me@example.com", "t0", "2026-11-09T20:00:00Z"],
        ["two@example.com", "t0", "2026-11-09T20:00:00Z"],
      ],
    );
    assert.equal(r.accounts.length, 3);
    assert.deepEqual(r.accounts.slice(0, 2), [
      { account: "me@example.com", threads: 2, more_matches: true },
      { account: "two@example.com", threads: 2, more_matches: true },
    ]);
    assert.match(r.accounts[2].error, /old@example.com cannot be decrypted/);
    assert.match(r.note, /does not have the threads of an account with an error/);
    assert.deepEqual(calls.map((c) => c.accountId).sort(), ["acct-1", "acct-2", "acct-3"]);
    assert.ok(calls.every((c) => !c.change));
  });

  test("search_all_accounts gives the threads that Gmail did not read in each account", async () => {
    mod.OTHER_ACCOUNTS.pop();
    gmail.readFails.add("t2");
    const r = await callAll("search_all_accounts", { query: failures, max_results: 2 });
    assert.deepEqual(r.threads.map((t) => [t.account, t.thread_id]), [["me@example.com", "t0"], ["two@example.com", "t0"]]);
    assert.deepEqual(r.accounts[0], {
      account: "me@example.com",
      threads: 1,
      more_matches: true,
      not_read: [{ thread_id: "t2", error: "The read failed." }],
    });
    assert.match(r.note, /threads in not_read of an account.*To try again, call search_all_accounts again/);
  });

  test("summarise_all_accounts adds the counts of the accounts", async () => {
    gmail.threads.get("t0").labels.add("UNREAD");
    const r = await callAll("summarise_all_accounts", { query: failures, group_by: "sender" });
    assert.equal(r.total, 60);
    assert.equal(r.unread, 2);
    assert.deepEqual(r.accounts[0].groups.map((g) => [g.key, g.threads]), [["monitor@example.com", 30]]);
    assert.ok(r.accounts[2].error);
    assert.match(r.note, /^The counts do not include an account with an error/);
  });

  /** Adds linked accounts, so that the user has `count` accounts in all. */
  const addAccounts = (count) => {
    for (let i = mod.OTHER_ACCOUNTS.length + 2; i <= count; i++) {
      mod.OTHER_ACCOUNTS.push({ ...mod.TEST_ACCOUNT, id: `acct-${i}`, email: `a${i}@example.com` });
    }
  };

  test("search_all_accounts shares the requests to Google among many accounts, and leaves out the accounts after them", async () => {
    addAccounts(12);
    const r = await callAll("search_all_accounts", { query: "in:inbox", max_results: 50 });
    assert.ok(gmail.requests <= 50, `${gmail.requests} requests`);
    assert.equal(r.accounts[0].threads, 25);
    assert.match(r.note, /^With 12 accounts, the tool read at most 25 threads in each account/);
    assert.deepEqual(
      r.accounts.slice(10).map((a) => a.account),
      ["a11@example.com", "a12@example.com"],
    );
    assert.ok(r.accounts.slice(10).every((a) => /left out this account.*search_threads/.test(a.error)));
    assert.ok(!calls.some((c) => c.accountId === "acct-11" || c.accountId === "acct-12"));
  });

  test("summarise_all_accounts groups fewer threads in each of many accounts", async () => {
    addAccounts(7);
    const r = await callAll("summarise_all_accounts", { query: "in:inbox", group_by: "sender" });
    assert.ok(gmail.requests <= 50, `${gmail.requests} requests`);
    assert.equal(r.accounts[0].total, 60);
    assert.equal(r.accounts[0].grouped_threads, 50);
    assert.match(r.note, /^With 7 accounts, the tool grouped at most 50 threads in each account/);
  });

  test("a failure outside Google is the error of its account, not of the whole call", async () => {
    // Workers fails each fetch after the subrequest limit in this way.
    globalThis.fetch = async () => {
      throw new Error("Too many subrequests.");
    };
    const res = await client.callTool({ name: "search_all_accounts", arguments: { query: failures } });
    assert.ok(!res.isError);
    const r = JSON.parse(res.content[0].text);
    assert.deepEqual(r.accounts.slice(0, 2), [
      { account: "me@example.com", error: "Too many subrequests." },
      { account: "two@example.com", error: "Too many subrequests." },
    ]);
  });
});

describe("get_thread", () => {
  beforeEach(() => {
    gmail.mailThreads.set("g1", [
      { labels: ["INBOX"], headers: headers({ From: "ana@example.com", Subject: "Logs" }), body: "first" },
      { labels: ["INBOX"], headers: headers({ From: "ana@example.com", Subject: "Re: Logs" }), body: "x".repeat(300) },
    ]);
  });

  test("reads every message, shortened to max_chars_per_message", async () => {
    const r = await call("get_thread", { thread_id: "g1", max_chars_per_message: 200 });
    assert.deepEqual(r.messages.map((m) => m.body), ["first", `${"x".repeat(200)}\n…[truncated]`]);
  });

  test("reads one message", async () => {
    const r = await call("get_thread", { thread_id: "g1", message_id: "g1-1" });
    assert.deepEqual(r.messages.map((m) => [m.message_id, m.body]), [["g1-1", "x".repeat(300)]]);
  });

  test("gives the invitation of a message, and the part_id of each attachment", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:abc@outlook.com",
      "SEQUENCE:2",
      "SUMMARY:Review\\, part 2",
      "DTSTART;TZID=New Zealand Standard Time:20261112T100000",
      "DTEND;TZID=New Zealand Standard Time:20261112T110000",
      'ORGANIZER;CN="Smith, Ana":mailto:ana@example.com',
      "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:me@exa",
      " mple.com",
      "BEGIN:VALARM",
      "SUMMARY:Reminder",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const data = (t) => Buffer.from(t).toString("base64url");
    gmail.mailThreads.set("inv", [
      {
        labels: ["INBOX"],
        headers: headers({ From: "ana@example.com", Subject: "Invitation" }),
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              partId: "0",
              mimeType: "multipart/alternative",
              parts: [
                { partId: "0.0", mimeType: "text/plain", body: { data: data("Join us") } },
                { partId: "0.1", mimeType: "text/calendar", body: { data: data(ics) } },
              ],
            },
            { partId: "1", mimeType: "application/ics", filename: "invite.ics", body: { attachmentId: "att", size: 400 } },
          ],
        },
      },
    ]);
    const [m] = (await call("get_thread", { thread_id: "inv" })).messages;
    assert.equal(m.body, "Join us");
    assert.deepEqual(m.attachments, [{ part_id: "1", filename: "invite.ics", mimeType: "application/ics", size: 400 }]);
    assert.deepEqual(m.invitations, [
      {
        method: "REQUEST",
        uid: "abc@outlook.com",
        sequence: 2,
        status: null,
        summary: "Review, part 2",
        location: null,
        start: "2026-11-12T10:00:00",
        end: "2026-11-12T11:00:00",
        time_zone: "New Zealand Standard Time",
        all_day: false,
        recurrence: null,
        recurrence_id: null,
        organizer: { email: "ana@example.com", name: "Smith, Ana" },
        guests: [{ email: "me@example.com", name: "Me", response: "needs-action" }],
      },
    ]);
  });

  test("refuses a message of another thread", async () => {
    gmail.mailThreads.set("g2", [{ labels: [], headers: [], body: "other" }]);
    assert.match((await call("get_thread", { thread_id: "g1", message_id: "g2-0" })).text, /not in thread g1/);
  });
});

describe("get_attachment", () => {
  const data = (t) => Buffer.from(t).toString("base64url");

  beforeEach(() => {
    gmail.attachments.set("pdf", data("%PDF-1.7 bytes"));
    gmail.attachments.set("log", data("line 1\nline 2\n".repeat(100)));
    gmail.mailThreads.set("f1", [
      {
        labels: ["INBOX"],
        headers: headers({ From: "billing@example.com", Subject: "Invoice" }),
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { partId: "0", mimeType: "text/plain", body: { data: data("See attached") } },
            { partId: "1", mimeType: "application/octet-stream", filename: "INV-42.PDF", body: { attachmentId: "pdf", size: 14 } },
            { partId: "2", mimeType: "application/octet-stream", filename: "backup.log", body: { attachmentId: "log", size: 1400 } },
            { partId: "3", mimeType: "text/html", filename: "report.html", body: { data: data("<p>Done &amp; dusted</p>"), size: 24 } },
            { partId: "4", mimeType: "text/calendar", filename: "invite.ics", body: { data: data("BEGIN:VEVENT\nSUMMARY:Call\nEND:VEVENT"), size: 36 } },
            { partId: "5", mimeType: "image/png", filename: "logo.png", body: { attachmentId: "png", size: 10 } },
            { partId: "6", mimeType: "application/pdf", filename: "huge.pdf", body: { attachmentId: "huge", size: 11 * 1024 * 1024 } },
          ],
        },
      },
    ]);
  });

  const read = (part_id, extra = {}) => call("get_attachment", { message_id: "f1-0", part_id, ...extra });

  test("converts a PDF with Workers AI, by its extension, without image conversion", async () => {
    const r = await read("1");
    assert.equal(r.text, "# Invoice\n\nTotal: $120, due 2026-12-01");
    assert.deepEqual(conversions.map((c) => [c.name, c.type, c.text]), [["INV-42.PDF", "application/pdf", "%PDF-1.7 bytes"]]);
    assert.equal(conversions[0].options.conversionOptions.pdf.images.convert, false);
  });

  test("reads text, HTML and calendar files, and shortens long text", async () => {
    const log = await read("2", { max_chars: 200 });
    assert.equal(log.text, `${"line 1\nline 2\n".repeat(100).slice(0, 200)}\n…[truncated]`);
    assert.equal(log.total_chars, 1400);
    assert.equal((await read("3")).text, "Done & dusted");
    assert.deepEqual((await read("4")).events.map((e) => e.summary), ["Call"]);
    assert.deepEqual(conversions, []);
  });

  test("refuses images, large files and unknown parts, and reports a failed conversion", async () => {
    assert.match((await read("5")).text, /cannot read the attachment "logo.png"/);
    assert.match((await read("6")).text, /11.0 MB/);
    assert.match((await read("9")).text, /no attachment with part_id 9/);
    conversionResult = { format: "error", error: "Unsupported file" };
    assert.match((await read("1")).text, /could not convert the document: Unsupported file/);
  });
});

describe("modify_thread_labels", () => {
  test("still changes one thread", async () => {
    const r = await call("modify_thread_labels", { thread_id: "t5", add: ["Existing"], remove: ["INBOX"] });
    assert.equal(r.thread_id, "t5");
    assert.deepEqual([...gmail.threads.get("t5").labels], ["Label_1"]);
    assert.deepEqual(gmail.batches, []);
  });
});

describe("send_draft", () => {
  /** Sets the two send permissions of the test mailbox. */
  const allow = (send, reply) => {
    mod.TEST_ACCOUNT.allow_send = send ? 1 : 0;
    mod.TEST_ACCOUNT.allow_reply_email = reply ? 1 : 0;
  };

  beforeEach(() => {
    allow(false, true);
    gmail.mailThreads.set("r1", [
      {
        labels: ["INBOX"],
        headers: headers({
          "Message-ID": "<orig@example.com>",
          From: '"Smith, Ana" <Ana@Example.com>',
          To: "me@example.com, Bob <bob@example.com>",
          Cc: "carol@example.com",
          "Reply-To": "team@example.com",
        }),
      },
      { labels: ["DRAFT"], headers: headers({ "Message-ID": "<draft@example.com>", From: "me@example.com", To: "eve@evil.example" }) },
    ]);
  });

  /** Saves a draft in thread r1 with the headers, and returns the result of send_draft for it. */
  const send = async (h) => {
    const id = `d${gmail.drafts.size + 1}`;
    gmail.drafts.set(id, { threadId: "r1", headers: headers(h) });
    return call("send_draft", { draft_id: id });
  };

  test("sends a reply to the sender", async () => {
    const r = await send({ To: '"Smith, Ana" <ana@example.com>', "In-Reply-To": "<orig@example.com>" });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(gmail.sent, ["d1"]);
  });

  test("sends a reply to all, and to the Reply-To address", async () => {
    const r = await send({
      To: "team@example.com, ANA@example.com",
      Cc: "Bob <bob@example.com>, carol@example.com, me@example.com",
      "In-Reply-To": "<orig@example.com>",
    });
    assert.ok(!r.isError, r.text);
    assert.equal(gmail.sent.length, 1);
  });

  test("refuses a reply that adds a person, also in Bcc", async () => {
    for (const h of [
      { To: "ana@example.com, dan@example.com" },
      { To: "ana@example.com", Cc: "dan@example.com" },
      { To: "ana@example.com", Bcc: "dan@example.com" },
    ]) {
      const r = await send({ ...h, "In-Reply-To": "<orig@example.com>" });
      assert.match(r.text, /not on the message that the draft answers: dan@example.com/);
    }
    assert.deepEqual(gmail.sent, []);
  });

  test("refuses a new message, and a reply to a draft", async () => {
    assert.match((await send({ To: "ana@example.com" })).text, /not a reply\./);
    assert.match((await send({ To: "eve@evil.example", "In-Reply-To": "<draft@example.com>" })).text, /not a reply to a message in its thread/);
    assert.match((await send({ To: "ana@example.com", "In-Reply-To": "<other@example.com>" })).text, /not a reply to a message in its thread/);
    assert.deepEqual(gmail.sent, []);
  });

  test("an address in a display name does not count", async () => {
    gmail.mailThreads.get("r1")[0].headers = headers({ "Message-ID": "<orig@example.com>", From: '"eve@evil.example" <ana@example.com>' });
    const r = await send({ To: "eve@evil.example", "In-Reply-To": "<orig@example.com>" });
    assert.match(r.text, /eve@evil.example/);
    assert.deepEqual(gmail.sent, []);
  });

  test("without either setting, sends nothing", async () => {
    allow(false, false);
    const r = await send({ To: "ana@example.com", "In-Reply-To": "<orig@example.com>" });
    assert.match(r.text, /did not select "Allow sending email"/);
    assert.deepEqual(gmail.sent, []);
  });

  test("with Allow sending email, sends any draft", async () => {
    allow(true, false);
    assert.ok(!(await send({ To: "dan@example.com" })).isError);
    assert.equal(gmail.sent.length, 1);
  });

  test("list_accounts gives can_reply", async () => {
    const permissions = async () => {
      const [a] = JSON.parse((await client.callTool({ name: "list_accounts", arguments: {} })).content[0].text).accounts;
      return { can_send: a.can_send, can_reply: a.can_reply };
    };
    assert.deepEqual(await permissions(), { can_send: false, can_reply: true });
    allow(true, false);
    assert.deepEqual(await permissions(), { can_send: true, can_reply: true });
    allow(false, false);
    assert.deepEqual(await permissions(), { can_send: false, can_reply: false });
  });
});

describe("tool list version", () => {
  /** Returns the version in the description of a tool, and the version in its result, from a client of one server. */
  const versions = async (c, name) => {
    const { tools } = await c.listTools();
    const described = /This tool list has version ([\w-]+)\./.exec(tools.find((t) => t.name === name).description)?.[1];
    const current = JSON.parse((await c.callTool({ name, arguments: {} })).content[0].text).tool_list_version;
    return { described, current };
  };

  test("list_accounts and about_mailroom give the same version as their descriptions", async () => {
    for (const name of ["list_accounts", "about_mailroom"]) {
      const { described, current } = await versions(client, name);
      assert.ok(current?.length >= 12);
      assert.equal(described, current);
    }
  });

  test("an old tool list gives another version than the results", async () => {
    const { described, current } = await versions(await connect({ APP_NAME: "Mailroom" }, "old"), "about_mailroom");
    assert.equal(described, "old");
    assert.notEqual(current, "old");
  });
});

describe("drafts", () => {
  beforeEach(() => {
    gmail.drafts.set("d1", {
      threadId: "r1",
      headers: headers({
        From: "Me at work <me@work.example.com>",
        To: "Ana <ana@example.com>",
        Cc: "bob@example.com",
        Subject: "Re: Plans",
        "In-Reply-To": "<orig@example.com>",
        References: "<orig@example.com>",
      }),
      body: "Old text",
    });
    gmail.drafts.set("d2", { threadId: "r2", headers: headers({ To: "carol@example.com", Subject: "Invoice" }), body: "Hello" });
  });

  /** Returns the headers and the decoded body of the message that the upload API got. */
  const uploaded = () => {
    const [{ message }] = gmail.uploads;
    const [head, ...rest] = message.split("\r\n\r\n");
    const fields = Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
    return { fields, body: Buffer.from(rest.join("").replace(/\r\n/g, ""), "base64").toString() };
  };

  test("list_drafts gives the recipients, subject and snippet of each draft", async () => {
    const r = await call("list_drafts", {});
    assert.deepEqual(r.drafts, [
      { draft_id: "d1", thread_id: "r1", to: "Ana <ana@example.com>", cc: "bob@example.com", subject: "Re: Plans", date: null, snippet: "Old text" },
      { draft_id: "d2", thread_id: "r2", to: "carol@example.com", cc: null, subject: "Invoice", date: null, snippet: "Hello" },
    ]);
    assert.deepEqual(kinds("read"), [2]);
  });

  test("list_drafts gives the drafts that Gmail read, and the drafts that it did not read", async () => {
    gmail.readFails.add("d1");
    const r = await call("list_drafts", {});
    assert.deepEqual(r.drafts.map((d) => d.draft_id), ["d2"]);
    assert.deepEqual(r.not_read, [{ draft_id: "d1", error: "The read failed." }]);
    assert.match(r.note, /To try again, call list_drafts again/);
  });

  test("update_draft changes the body, and keeps the sender, the recipients and the reply headers", async () => {
    const r = await call("update_draft", { draft_id: "d1", body: "New text" });
    assert.equal(r.draft_id, "d1");
    assert.deepEqual(gmail.uploads[0].metadata, { id: "d1", message: { threadId: "r1" } });
    const { fields, body } = uploaded();
    assert.equal(body, "New text");
    assert.equal(fields.From, "Me at work <me@work.example.com>");
    assert.equal(fields.To, "Ana <ana@example.com>");
    assert.equal(fields.Cc, "bob@example.com");
    assert.equal(fields.Subject, "Re: Plans");
    assert.equal(fields["In-Reply-To"], "<orig@example.com>");
    assert.equal(fields.References, "<orig@example.com>");
  });

  test("update_draft changes the recipients, removes Cc, and keeps the body", async () => {
    await call("update_draft", { draft_id: "d1", to: "dan@example.com", cc: "" });
    const { fields, body } = uploaded();
    assert.equal(fields.To, "dan@example.com");
    assert.equal(fields.Cc, undefined);
    assert.equal(body, "Old text");
  });

  test("update_draft gives no sender for a draft without one, so that Gmail uses the default address", async () => {
    await call("update_draft", { draft_id: "d2", subject: "Invoice 42" });
    const { fields } = uploaded();
    assert.equal(fields.From, undefined);
    assert.equal(fields.Subject, "Invoice 42");
  });

  test("delete_draft deletes the draft", async () => {
    const r = await call("delete_draft", { draft_id: "d2" });
    assert.equal(r.draft_id, "d2");
    assert.deepEqual([...gmail.drafts.keys()], ["d1"]);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: true }]);
  });

  test("update_draft needs a change", async () => {
    assert.match((await call("update_draft", { draft_id: "d1" })).text, /at least one field/);
    assert.deepEqual(gmail.uploads, []);
  });
});

describe("list_event_changes", () => {
  const calendarScopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ].join(" ");
  let scopes;
  beforeEach(() => {
    scopes = mod.TEST_ACCOUNT.scopes;
    mod.TEST_ACCOUNT.scopes = calendarScopes;
    const at = (dateTime) => ({ dateTime, timeZone: "Pacific/Auckland" });
    gmail.events = [
      { id: "new", status: "confirmed", created: "2026-11-12T01:00:00Z", updated: "2026-11-12T01:00:00Z", summary: "Coffee", start: at("2026-11-12T15:00:00+13:00"), end: at("2026-11-12T15:30:00+13:00") },
      {
        id: "moved_20261112",
        recurringEventId: "moved",
        status: "confirmed",
        created: "2026-10-01T00:00:00Z",
        updated: "2026-11-12T02:00:00Z",
        summary: "Stand-up",
        start: at("2026-11-12T11:00:00+13:00"),
        end: at("2026-11-12T11:15:00+13:00"),
        originalStartTime: at("2026-11-12T10:00:00+13:00"),
        attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }],
      },
      { id: "gone", status: "cancelled" },
    ];
  });
  afterEach(() => {
    mod.TEST_ACCOUNT.scopes = scopes;
  });

  test("lists new, changed and cancelled events since a time", async () => {
    const r = await call("list_event_changes", { since: "2026-11-12T08:00:00+13:00", time_min: "2026-11-12T00:00:00+13:00" });
    assert.deepEqual(r.events.map((e) => [e.event_id, e.change, e.original_start ?? null, e.my_response]), [
      ["new", "new", null, null],
      ["moved_20261112", "changed", "2026-11-12T10:00:00+13:00", "needsAction"],
      ["gone", "cancelled", null, null],
    ]);
    const [q] = gmail.eventQueries;
    assert.equal(q.updatedMin, "2026-11-11T19:00:00.000Z");
    assert.equal(q.timeMin, "2026-11-12T00:00:00+13:00");
    assert.equal(q.showDeleted, "true");
    assert.equal(q.singleEvents, "true");
  });

  test("explains a since that is too far in the past", async () => {
    gmail.eventsGone = true;
    assert.match((await call("list_event_changes", { since: "2026-01-01T00:00:00Z" })).text, /too far in the past/);
    assert.match((await call("list_event_changes", { since: "yesterday" })).text, /RFC 3339/);
  });
});

describe("parseIcs", () => {
  const ics = (...lines) => ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\n");

  test("reads UTC times, all-day dates, a cancellation and a change to one instance", () => {
    const [timed, allDay] = mod.parseIcs(
      ics(
        "BEGIN:VEVENT",
        "DTSTART:20261112T200000Z",
        "DURATION:PT1H",
        "RECURRENCE-ID:20261112T200000Z",
        "STATUS:CANCELLED",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20261224",
        "DTEND;VALUE=DATE:20261225",
        "RRULE:FREQ=YEARLY",
        "END:VEVENT",
        "METHOD:CANCEL",
      ),
    );
    assert.equal(timed.method, "CANCEL");
    assert.equal(timed.status, "CANCELLED");
    assert.deepEqual([timed.start, timed.end, timed.duration, timed.all_day, timed.recurrence_id], [
      "2026-11-12T20:00:00Z",
      null,
      "PT1H",
      false,
      "2026-11-12T20:00:00Z",
    ]);
    assert.deepEqual([allDay.start, allDay.end, allDay.all_day, allDay.recurrence], ["2026-12-24", "2026-12-25", true, "FREQ=YEARLY"]);
  });

  test("gives at most 50 guests, and nothing for other text", () => {
    const guests = Array.from({ length: 53 }, (_, i) => `ATTENDEE:mailto:g${i}@example.com`);
    const [e] = mod.parseIcs(ics("BEGIN:VEVENT", ...guests, "END:VEVENT"));
    assert.equal(e.guests.length, 50);
    assert.equal(e.more_guests, 3);
    assert.deepEqual(mod.parseIcs("Hello"), []);
  });
});

describe("agent state", () => {
  beforeEach(() => mod.resetState());

  /** Calls a state tool, for the test account or, with account null, for the global notes. Returns its JSON result, or its error. */
  const state = async (name, args, account = "me@example.com") => {
    const res = await client.callTool({ name, arguments: { ...(account ? { account } : {}), ...args } });
    return res.isError ? { isError: true, text: res.content[0].text } : JSON.parse(res.content[0].text);
  };

  test("saves, reads and deletes notes of an account, and counts calls but no changes", async () => {
    assert.deepEqual(await state("set_state", { key: "sent/t1", value: "yes", agent_label: "Digest" }), {
      account: "me@example.com",
      key: "sent/t1",
      version: 1,
    });
    await state("set_state", { key: "count", value: "3" });
    const read = await state("get_state", { prefix: "sent/" });
    assert.equal(read.notes.length, 1);
    assert.equal(read.notes[0].value, "yes");
    assert.equal(read.notes[0].saved_by, "Unknown app (Digest)");
    assert.deepEqual(await state("delete_state", { keys: ["sent/t1", "count"] }), { account: "me@example.com", deleted: 2 });
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.accountId === "acct-1" && !c.change));
  });

  test("keeps the global notes apart from the notes of an account", async () => {
    await state("set_state", { key: "briefing/last_run", value: "2026-11-12T07:00:00Z" }, null);
    assert.deepEqual((await state("get_state", {}, null)).notes.map((n) => n.key), ["briefing/last_run"]);
    assert.deepEqual((await state("get_state", {})).notes, []);
    assert.equal((await state("get_state", {}, null)).account, null);
    // Only the call for the account counts in the usage of an account.
    assert.deepEqual(calls, [{ accountId: "acct-1", change: false }]);
  });

  test("if_version refuses a save over a change by another agent", async () => {
    await state("set_state", { key: "n", value: "1", if_version: 0 });
    assert.match((await state("set_state", { key: "n", value: "x", if_version: 0 })).text, /already exists/);
    assert.equal((await state("set_state", { key: "n", value: "2", if_version: 1 })).version, 2);
    assert.match((await state("set_state", { key: "n", value: "x", if_version: 1 })).text, /does not have version 1/);
  });

  test("refuses an unknown account", async () => {
    assert.match((await state("get_state", {}, "nobody@example.com")).text, /no linked mailbox "nobody@example.com"/);
  });
});

describe("addressList", () => {
  test("reads addresses with and without names", () => {
    assert.deepEqual(mod.addressList('"Smith, Ana" <Ana@Example.com>, bob@example.com; Carol (work) <carol@example.com>'), [
      "ana@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    assert.deepEqual(mod.addressList('"x@y.com" <z@example.com>'), ["z@example.com"]);
    assert.deepEqual(mod.addressList(undefined), []);
    assert.deepEqual(mod.addressList("undisclosed-recipients:;"), []);
  });
});

describe("batch format", () => {
  test("parses a real Gmail batch response", async () => {
    const body = await readFile(join(root, "test/fixtures/gmail-batch-401.http"), "utf8");
    const type = (await readFile(join(root, "test/fixtures/gmail-batch-401.content-type"), "utf8")).trim();
    const parts = mod.parseBatchResponse(type, body);
    assert.deepEqual([...parts.keys()].sort(), [0, 1]);
    for (const p of parts.values()) {
      assert.equal(p.status, 401);
      assert.match(p.body.error.message, /invalid authentication credentials/);
    }
  });
});
