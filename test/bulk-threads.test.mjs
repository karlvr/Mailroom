// Tests of the bulk thread tools: labels and trash. The test bundles the real src/mcp.ts with esbuild, replaces the D1
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
    this.batches.push(calls.length);
    const rejectToken = this.rejectTokenOnce || auth !== `Bearer ${this.validToken}`;
    this.rejectTokenOnce = false;
    const out = "batch_FAKE";
    const parts = calls.map((c) => {
      let status;
      let body;
      if (rejectToken) {
        [status, body] = [401, { error: { code: 401, message: "Request had invalid authentication credentials." } }];
      } else {
        const m = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/(modify|trash)$/.exec(c.path);
        assert.ok(m && c.method === "POST", `unexpected batch call ${c.method} ${c.path}`);
        const id = decodeURIComponent(m[1]);
        [status, body] = m[2] === "trash" ? this.trash(id) : this.modify(id, c.body);
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

describe("modify_labels_by_query", () => {
  test("changes every matching thread, in batches of at most 25, and creates a missing label", async () => {
    const r = await call("modify_labels_by_query", {
      query: 'subject:"PopularityService failure"',
      add: ["Ops/PopularityService"],
      remove: ["INBOX"],
    });
    assert.equal(r.matched, 30);
    assert.equal(r.changed, 30);
    assert.deepEqual(r.failed, []);
    assert.equal(r.more_matches, false);
    const id = gmail.labelId("Ops/PopularityService");
    assert.ok(id, "the tool created the label");
    for (const [tid, t] of gmail.threads) {
      const failure = t.subject === "PopularityService failure";
      assert.equal(t.labels.has(id), failure, `${tid} label`);
      assert.equal(t.labels.has("INBOX"), !failure, `${tid} inbox`);
    }
    assert.deepEqual(gmail.batches, [25, 5]);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: true }]);
  });

  test("a dry run changes nothing, creates no label and does not count as a change", async () => {
    const r = await call("modify_labels_by_query", { query: 'subject:"PopularityService failure"', add: ["New"], dry_run: true });
    assert.equal(r.dry_run, true);
    assert.equal(r.matched, 30);
    assert.equal(r.thread_ids.length, 30);
    assert.equal(gmail.labelId("New"), undefined);
    assert.deepEqual(gmail.batches, []);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: false }]);
  });

  test("stops at max_threads and reports more_matches", async () => {
    const r = await call("modify_labels_by_query", { query: "in:inbox", add: ["Existing"], max_threads: 10 });
    assert.equal(r.matched, 10);
    assert.equal(r.changed, 10);
    assert.equal(r.more_matches, true);
    const labelled = [...gmail.threads.values()].filter((t) => t.labels.has("Label_1")).length;
    assert.equal(labelled, 10);
  });

  test("follows page tokens past one page of the thread list", async () => {
    gmail = new FakeGmail(700);
    const r = await call("modify_labels_by_query", { query: "in:inbox", add: ["Existing"] });
    assert.equal(r.matched, 500);
    assert.equal(r.changed, 500);
    assert.equal(r.more_matches, true);
    assert.equal(gmail.batches.length, 20);
  });

  test("a search with no matches changes nothing", async () => {
    const r = await call("modify_labels_by_query", { query: 'subject:"nothing"', add: ["New"] });
    assert.equal(r.matched, 0);
    assert.equal(r.changed, 0);
    assert.equal(gmail.labelId("New"), undefined);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: false }]);
  });

  test("rejects an empty search, forbidden labels and an empty change", async () => {
    assert.ok((await call("modify_labels_by_query", { query: "  ", add: ["X"] })).isError);
    const trash = await call("modify_labels_by_query", { query: "in:inbox", add: ["Trash"], dry_run: true });
    assert.match(trash.text, /cannot add or remove these labels: Trash/);
    assert.match((await call("modify_labels_by_query", { query: "in:inbox" })).text, /at least one label/);
    assert.deepEqual(gmail.batches, []);
  });
});

describe("modify_threads_labels", () => {
  test("changes each thread, tries rate-limited threads again and reports unknown threads", async () => {
    gmail.rateLimitOnce = new Set(["t3", "t7"]);
    const r = await call("modify_threads_labels", { thread_ids: ["t1", "t3", "t7", "t3", "nope"], add: ["STARRED"], remove: ["INBOX"] });
    assert.equal(r.threads, 4);
    assert.equal(r.changed, 3);
    assert.deepEqual(r.failed, [{ thread_id: "nope", error: "Requested entity was not found." }]);
    for (const id of ["t1", "t3", "t7"]) {
      assert.ok(gmail.threads.get(id).labels.has("STARRED"));
      assert.ok(!gmail.threads.get(id).labels.has("INBOX"));
    }
    assert.deepEqual(gmail.batches, [4, 2]);
  });

  test("gets a new token when Gmail rejects the token inside a batch", async () => {
    await call("modify_threads_labels", { thread_ids: ["t1"], add: ["Existing"] });
    const before = gmail.tokenRequests;
    gmail.rejectTokenOnce = true;
    const r = await call("modify_threads_labels", { thread_ids: ["t2", "t4"], add: ["Existing"] });
    assert.equal(r.changed, 2);
    assert.deepEqual(r.failed, []);
    assert.equal(gmail.tokenRequests, before + 1);
  });

  test("reports a label to remove that does not exist", async () => {
    const r = await call("modify_threads_labels", { thread_ids: ["t1"], remove: ["Missing"] });
    assert.deepEqual(r.labels_not_found, ["Missing"]);
  });
});

describe("trash_threads_by_query", () => {
  test("trashes every matching thread, and a second call finds none", async () => {
    const r = await call("trash_threads_by_query", { query: 'subject:"PopularityService failure"' });
    assert.equal(r.matched, 30);
    assert.equal(r.trashed, 30);
    assert.deepEqual(r.failed, []);
    for (const t of gmail.threads.values()) assert.equal(!!t.trashed, t.subject === "PopularityService failure");
    assert.deepEqual(gmail.batches, [25, 5]);
    assert.deepEqual(calls, [{ accountId: "acct-1", change: true }]);
    const again = await call("trash_threads_by_query", { query: 'subject:"PopularityService failure"' });
    assert.equal(again.matched, 0);
  });

  test("a dry run trashes nothing and does not count as a change", async () => {
    const r = await call("trash_threads_by_query", { query: "in:inbox", dry_run: true, max_threads: 50 });
    assert.equal(r.matched, 50);
    assert.equal(r.more_matches, true);
    assert.equal(r.thread_ids.length, 50);
    assert.ok([...gmail.threads.values()].every((t) => !t.trashed));
    assert.deepEqual(calls, [{ accountId: "acct-1", change: false }]);
  });

  test("continues where the previous call stopped", async () => {
    const first = await call("trash_threads_by_query", { query: "in:inbox", max_threads: 40 });
    assert.equal(first.trashed, 40);
    assert.equal(first.more_matches, true);
    const second = await call("trash_threads_by_query", { query: "in:inbox", max_threads: 40 });
    assert.equal(second.trashed, 20);
    assert.equal(second.more_matches, false);
    assert.ok([...gmail.threads.values()].every((t) => t.trashed));
  });

  test("rejects an empty search", async () => {
    assert.ok((await call("trash_threads_by_query", { query: "" })).isError);
  });
});

describe("trash_threads", () => {
  test("trashes each thread, tries rate-limited threads again and reports unknown threads", async () => {
    gmail.rateLimitOnce = new Set(["t2"]);
    const r = await call("trash_threads", { thread_ids: ["t1", "t2", "nope"] });
    assert.equal(r.threads, 3);
    assert.equal(r.trashed, 2);
    assert.deepEqual(r.failed, [{ thread_id: "nope", error: "Requested entity was not found." }]);
    assert.ok(gmail.threads.get("t1").trashed && gmail.threads.get("t2").trashed);
    assert.ok(!gmail.threads.get("t3").trashed);
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
