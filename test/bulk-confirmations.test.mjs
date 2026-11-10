// Tests the SQL of the bulk confirmations in src/db.ts, with every migration applied to SQLite, the
// database engine of D1. A small shim gives the parts of the D1 API that the functions use.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
let db;

before(async () => {
  const out = await build({
    entryPoints: [join(root, "src/db.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  db = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
});

/** Returns an Env whose DB is a new SQLite database with every migration. */
async function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of (await readdir(join(root, "migrations"))).sort()) sqlite.exec(await readFile(join(root, "migrations", f), "utf8"));
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => statement(sql, p),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => sqlite.prepare(sql).run(...params),
  });
  const DB = {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try {
        for (const s of list) sqlite.prepare(s.sql).run(...s.params);
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { env: { DB }, sqlite };
}

/** Inserts a row with the given values, and a placeholder in each other column that must have a value. */
function insertRow(sqlite, table, values) {
  const row = { ...values };
  for (const c of sqlite.prepare(`PRAGMA table_info(${table})`).all()) {
    if (c.name in row || !c.notnull || c.dflt_value !== null) continue;
    row[c.name] = /INT/i.test(c.type) ? 0 : "x";
  }
  const names = Object.keys(row);
  sqlite.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
}

const preview = (over = {}) => ({
  tokenHash: "hash-1",
  accountId: "acct-1",
  action: '{"tool":"trash_threads_by_query","query":"x"}',
  threadIds: ["t1", "t2"],
  expiresAt: Date.now() + 600_000,
  ...over,
});

test("a preview gives its threads once", async () => {
  const { env } = await freshEnv();
  await db.saveBulkConfirmation(env, preview());
  assert.deepEqual(await db.takeBulkConfirmation(env, "hash-1", "acct-1", preview().action), ["t1", "t2"]);
  assert.equal(await db.takeBulkConfirmation(env, "hash-1", "acct-1", preview().action), null);
});

test("a preview does not work for another account or action, and stays for the right one", async () => {
  const { env } = await freshEnv();
  await db.saveBulkConfirmation(env, preview());
  assert.equal(await db.takeBulkConfirmation(env, "hash-1", "acct-2", preview().action), null);
  assert.equal(await db.takeBulkConfirmation(env, "hash-1", "acct-1", '{"tool":"trash_threads_by_query","query":"y"}'), null);
  assert.deepEqual(await db.takeBulkConfirmation(env, "hash-1", "acct-1", preview().action), ["t1", "t2"]);
});

test("an expired preview does not work, and a new preview deletes it", async () => {
  const { env, sqlite } = await freshEnv();
  await db.saveBulkConfirmation(env, preview({ expiresAt: Date.now() - 1 }));
  assert.equal(await db.takeBulkConfirmation(env, "hash-1", "acct-1", preview().action), null);
  await db.saveBulkConfirmation(env, preview({ tokenHash: "hash-2" }));
  assert.deepEqual(
    sqlite.prepare("SELECT token_hash FROM bulk_confirmations").all().map((r) => r.token_hash),
    ["hash-2"],
  );
});

test("deleting an account deletes its previews", async () => {
  const { env, sqlite } = await freshEnv();
  insertRow(sqlite, "users", { id: "user-1", email: "me@example.com" });
  insertRow(sqlite, "accounts", { id: "acct-1", user_id: "user-1", email: "me@example.com" });
  await db.saveBulkConfirmation(env, preview());
  await db.deleteAccount(env, "user-1", "acct-1");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bulk_confirmations").get().n, 0);
});
