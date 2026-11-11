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
        export { buildServer } from ${JSON.stringify(join(root, "src/mcp.ts"))};
        export { parseBatchResponse, batchRequestBody } from ${JSON.stringify(join(root, "src/google.ts"))};
        export { TEST_ACCOUNT, OTHER_ACCOUNTS } from ${JSON.stringify(join(root, "test/support/db-stub.ts"))};
        export { addressList } from ${JSON.stringify(join(root, "src/mime.ts"))};
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
    /** Drafts by ID: the thread and the headers of each. */
    this.drafts = new Map();
    /** Threads for send_draft, by ID: the labels and headers of each message. */
    this.mailThreads = new Map();
    /** The IDs of the drafts that Gmail sent. */
    this.sent = [];
    /** The number of requests that the fake got, as Workers counts subrequests. */
    this.requests = 0;
    this.tokenRequests = 0;
    this.tokens = 0;
    /** The access tokens that this fake issued. Like Google, it accepts each of them. */
    this.issued = new Set();
    /** Thread IDs whose next modify gets 429 once. */
    this.rateLimitOnce = new Set();
    /** When true, the next batch rejects the token of every call, as Gmail does for an expired token. */
    this.rejectTokenOnce = false;
  }

  matches(q) {
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

  read(id) {
    const t = this.threads.get(id);
    if (!t) return [404, { error: { code: 404, message: "Requested entity was not found." } }];
    const headers = [
      { name: "From", value: t.from ?? "Monitor <monitor@example.com>" },
      { name: "Subject", value: t.subject },
      { name: "Date", value: t.date ?? "Tue, 10 Nov 2026 09:00:00 +1300" },
      ...(t.list ? [{ name: "List-Id", value: t.list }] : []),
    ];
    return [200, { id, messages: [{ id: `${id}-m1`, threadId: id, labelIds: [...t.labels], payload: { headers } }] }];
  }

  trash(id) {
    const t = this.threads.get(id);
    if (!t) return [404, { error: { code: 404, message: "Requested entity was not found." } }];
    if (this.rateLimitOnce.delete(id)) return [429, { error: { code: 429, message: "User-rate limit exceeded." } }];
    t.trashed = true;
    return [200, { id }];
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
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/labels" && method === "GET") return Response.json({ labels: this.labels });
    if (path === "/labels" && method === "POST") {
      const { name } = JSON.parse(init.body);
      const label = { id: `Label_${this.labels.length + 1}`, name, type: "user" };
      this.labels.push(label);
      return Response.json(label);
    }
    if (path === "/threads" && method === "GET") {
      const all = this.matches(url.searchParams.get("q"));
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return Response.json({ threads: page.map((id) => ({ id })), ...(next ? { nextPageToken: next } : {}) });
    }
    const draft = /^\/drafts\/([^/]+)$/.exec(path);
    if (draft && method === "GET") {
      const d = this.drafts.get(decodeURIComponent(draft[1]));
      if (!d) return Response.json({ error: { code: 404, message: "Requested entity was not found." } }, { status: 404 });
      return Response.json({ id: draft[1], message: { id: `${draft[1]}-m`, threadId: d.threadId, labelIds: ["DRAFT"], payload: { headers: d.headers } } });
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
    const message = /^\/messages\/([^/]+)-(\d+)$/.exec(path);
    if (message && method === "GET") {
      const id = decodeURIComponent(message[1]);
      if (!this.mailThreads.get(id)?.[Number(message[2])]) {
        return Response.json({ error: { code: 404, message: "Requested entity was not found." } }, { status: 404 });
      }
      return Response.json(this.mailMessage(id, Number(message[2])));
    }
    const m = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (m && method === "POST") {
      const [status, body] = this.modify(decodeURIComponent(m[1]), JSON.parse(init.body));
      return Response.json(body, { status });
    }
    throw new Error(`The fake Gmail has no route for ${method} ${url.href}`);
  }

  /** Returns message `i` of a thread for send_draft and get_thread, as Gmail gives it. */
  mailMessage(threadId, i) {
    const msg = this.mailThreads.get(threadId)[i];
    const body = msg.body === undefined ? {} : { mimeType: "text/plain", body: { data: Buffer.from(msg.body).toString("base64url") } };
    return { id: `${threadId}-${i}`, threadId, labelIds: msg.labels, payload: { headers: msg.headers, ...body } };
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
    const kind = calls[0].method === "GET" ? "read" : calls[0].path.endsWith("/trash") ? "trash" : "modify";
    this.batches.push(`${kind}:${calls.length}`);
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
        const m = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/(modify|trash)$/.exec(c.path);
        if (read && c.method === "GET") {
          [status, body] = this.read(decodeURIComponent(read[1]));
        } else {
          assert.ok(m && c.method === "POST", `unexpected batch call ${c.method} ${c.path}`);
          const id = decodeURIComponent(m[1]);
          [status, body] = m[2] === "trash" ? this.trash(id) : this.modify(id, c.body);
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
const realFetch = globalThis.fetch;

beforeEach(async () => {
  gmail = new FakeGmail(60);
  globalThis.fetch = (input, init) => gmail.fetch(input, init);
  calls = [];
  const env = { APP_NAME: "Mailroom" };
  const server = mod.buildServer(env, { props: { userId: "user-1", email: "me@example.com" }, clientId: null }, "https://mailroom.test", (c) =>
    calls.push(c),
  );
  const [a, b] = mod.InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new mod.Client({ name: "test", version: "1" });
  await client.connect(b);
});

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
    assert.deepEqual(kinds("modify"), []);
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
  test("changes every matching thread, in batches of at most 25, and creates a missing label", async () => {
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
    assert.deepEqual(kinds("modify"), [25, 5]);
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
    assert.equal(kinds("modify").length, 20);
  });

  test("rejects an empty search, forbidden labels and an empty change, before it reads mail", async () => {
    assert.ok((await call("modify_labels_by_query", { query: "  ", add: ["X"] })).isError);
    assert.match((await call("modify_labels_by_query", { query: "in:inbox", add: ["Trash"] })).text, /cannot add or remove these labels: Trash/);
    assert.match((await call("modify_labels_by_query", { query: "in:inbox" })).text, /at least one label/);
    assert.deepEqual(gmail.batches, []);
  });
});

describe("modify_threads_labels", () => {
  test("changes each thread, and tries rate-limited threads again", async () => {
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
    assert.deepEqual(kinds("modify"), [3, 2]);
  });

  test("a token does not work for another list of threads", async () => {
    const p = await preview("modify_threads_labels", { thread_ids: ["t1"], add: ["Existing"] });
    const r = await call("modify_threads_labels", { thread_ids: ["t1", "t2"], add: ["Existing"], confirmation_token: p.confirmation_token });
    assert.match(r.text, /does not work for this call/);
  });

  test("gets a new token when Gmail rejects the token inside a batch", async () => {
    const p = await preview("modify_threads_labels", { thread_ids: ["t2", "t4"], add: ["Existing"] });
    const before = gmail.tokenRequests;
    gmail.rejectTokenOnce = true;
    const r = await call("modify_threads_labels", { thread_ids: ["t2", "t4"], add: ["Existing"], confirmation_token: p.confirmation_token });
    assert.equal(r.changed, 2);
    assert.deepEqual(r.failed, []);
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
    assert.deepEqual(kinds("trash"), [25, 5]);
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

describe("trash_threads", () => {
  test("trashes each thread and tries rate-limited threads again", async () => {
    const p = await preview("trash_threads", { thread_ids: ["t1", "t2"] });
    gmail.rateLimitOnce = new Set(["t2"]);
    const r = await call("trash_threads", { thread_ids: ["t1", "t2"], confirmation_token: p.confirmation_token });
    assert.equal(r.trashed, 2);
    assert.ok(gmail.threads.get("t1").trashed && gmail.threads.get("t2").trashed);
    assert.ok(!gmail.threads.get("t3").trashed);
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
    assert.deepEqual(calls.map((c) => c.accountId).sort(), ["acct-1", "acct-2", "acct-3"]);
    assert.ok(calls.every((c) => !c.change));
  });

  test("summarise_all_accounts adds the counts of the accounts", async () => {
    gmail.threads.get("t0").labels.add("UNREAD");
    const r = await callAll("summarise_all_accounts", { query: failures, group_by: "sender" });
    assert.equal(r.total, 60);
    assert.equal(r.unread, 2);
    assert.deepEqual(r.accounts[0].groups.map((g) => [g.key, g.threads]), [["monitor@example.com", 30]]);
    assert.ok(r.accounts[2].error);
    assert.equal(r.note, undefined);
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

  test("refuses a message of another thread", async () => {
    gmail.mailThreads.set("g2", [{ labels: [], headers: [], body: "other" }]);
    assert.match((await call("get_thread", { thread_id: "g1", message_id: "g2-0" })).text, /not in thread g1/);
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
