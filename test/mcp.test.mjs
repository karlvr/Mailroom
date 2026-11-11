// Tests of the MCP tools: the bulk thread tools and send_draft. The test bundles the real src/mcp.ts with esbuild, replaces the D1
// parts of src/db.ts with test/support/db-stub.ts, and answers the Google requests with a fake Gmail.
import { after, before, beforeEach, describe, test } from "node:test";
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
        export { TEST_ACCOUNT } from ${JSON.stringify(join(root, "test/support/db-stub.ts"))};
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
    this.tokenRequests = 0;
    this.tokens = 0;
    this.validToken = null;
    /** Thread IDs whose next modify gets 429 once. */
    this.rateLimitOnce = new Set();
    /** When true, the next batch rejects the token of every call, as Gmail does for an expired token. */
    this.rejectTokenOnce = false;
  }

  matches(q) {
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
      { name: "From", value: "Monitor <monitor@example.com>" },
      { name: "Subject", value: t.subject },
      { name: "Date", value: "Tue, 10 Nov 2026 09:00:00 +1300" },
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
    const url = new URL(input instanceof URL || typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    if (url.href === "https://oauth2.googleapis.com/token") {
      this.tokenRequests++;
      this.validToken = `token-${++this.tokens}`;
      return Response.json({ access_token: this.validToken, expires_in: 3600 });
    }
    const auth = new Headers(init.headers).get("Authorization");
    if (url.href === "https://gmail.googleapis.com/batch/gmail/v1") return this.batch(init, auth);
    if (auth !== `Bearer ${this.validToken}`) return Response.json({ error: { code: 401, message: "bad token" } }, { status: 401 });
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
      const t = this.mailThreads.get(decodeURIComponent(thread[1]));
      return Response.json({
        id: thread[1],
        messages: t.map((msg, i) => ({ id: `${thread[1]}-${i}`, threadId: thread[1], labelIds: msg.labels, payload: { headers: msg.headers } })),
      });
    }
    const m = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (m && method === "POST") {
      const [status, body] = this.modify(decodeURIComponent(m[1]), JSON.parse(init.body));
      return Response.json(body, { status });
    }
    throw new Error(`The fake Gmail has no route for ${method} ${url.href}`);
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
    const rejectToken = this.rejectTokenOnce || auth !== `Bearer ${this.validToken}`;
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

describe("preview", () => {
  test("shows the sender, subject and date of each thread, and does not count as a change", async () => {
    const p = await preview("modify_labels_by_query", { query: failures, add: ["Ops"], remove: ["INBOX"] });
    assert.equal(p.preview, true);
    assert.equal(p.thread_count, 30);
    assert.deepEqual(p.threads[0], {
      thread_id: "t0",
      from: "Monitor <monitor@example.com>",
      subject: "PopularityService failure",
      date: "Tue, 10 Nov 2026 09:00:00 +1300",
      message_count: 1,
    });
    assert.ok(p.threads.every((t) => t.subject === "PopularityService failure"));
    assert.ok(p.confirmation_token.length > 20);
    assert.ok(Date.parse(p.expires_at) > Date.now());
    assert.deepEqual(kinds("read"), [25, 5]);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: false }]);
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
    assert.deepEqual(p.threads, []);
    assert.equal(p.confirmation_token, undefined);
  });

  test("a list with unknown threads previews only the threads that exist", async () => {
    const p = await preview("trash_threads", { thread_ids: ["t1", "nope", "t1"] });
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
    assert.deepEqual(again.threads, []);
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

describe("modify_thread_labels", () => {
  test("still changes one thread", async () => {
    const r = await call("modify_thread_labels", { thread_id: "t5", add: ["Existing"], remove: ["INBOX"] });
    assert.equal(r.thread_id, "t5");
    assert.deepEqual([...gmail.threads.get("t5").labels], ["Label_1"]);
    assert.deepEqual(gmail.batches, []);
  });
});

/** Returns Gmail headers from an object of names and values. */
const headers = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

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
