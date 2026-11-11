// Tests the SQL of the bulk confirmations in src/db.ts, with every migration applied to SQLite, the
// database engine of D1.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { insertRow, sqliteEnv } from "./support/sqlite-env.mjs";

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
const freshEnv = async () => sqliteEnv();

const preview = (over = {}) => ({
  tokenHash: "hash-1",
  accountId: "acct-1",
  action: '{"tool":"trash_threads_by_query","query":"x"}',
  listed: null,
  threads: [
    { threadId: "t1", messageIds: ["m1", "m2"] },
    { threadId: "t2", messageIds: ["m3"] },
  ],
  expiresAt: Date.now() + 600_000,
  ...over,
});

/** Returns the check of a confirmation of the preview, with the values in `over`. */
const check = (over = {}) => ({ tokenHash: "hash-1", accountId: "acct-1", action: preview().action, ...over });

test("a preview gives its threads and their messages once", async () => {
  const { env } = await freshEnv();
  await db.saveBulkConfirmation(env, preview());
  assert.deepEqual(await db.takeBulkConfirmation(env, check()), preview().threads);
  assert.equal(await db.takeBulkConfirmation(env, check()), null);
});

test("a preview does not work for another account or action, and stays for the right one", async () => {
  const { env } = await freshEnv();
  await db.saveBulkConfirmation(env, preview());
  assert.equal(await db.takeBulkConfirmation(env, check({ accountId: "acct-2" })), null);
  assert.equal(await db.takeBulkConfirmation(env, check({ action: '{"tool":"trash_threads_by_query","query":"y"}' })), null);
  assert.deepEqual(await db.takeBulkConfirmation(env, check()), preview().threads);
});

test("a preview does not work for another thread count, and stays for the right one", async () => {
  const { env } = await freshEnv();
  await db.saveBulkConfirmation(env, preview());
  assert.equal(await db.takeBulkConfirmation(env, check({ threadCount: 1 })), null);
  assert.deepEqual(await db.takeBulkConfirmation(env, check({ threadCount: 2 })), preview().threads);
});

test("a preview of a list does not work for another list, and works without the list", async () => {
  const { env } = await freshEnv();
  await db.saveBulkConfirmation(env, preview({ listed: "list-1" }));
  assert.equal(await db.takeBulkConfirmation(env, check({ listed: "list-2" })), null);
  assert.deepEqual(await db.takeBulkConfirmation(env, check({ threadCount: 2 })), preview().threads);
  await db.saveBulkConfirmation(env, preview({ listed: "list-1" }));
  assert.deepEqual(await db.takeBulkConfirmation(env, check({ listed: "list-1", threadCount: 2 })), preview().threads);
});

test("an expired preview does not work, and a new preview deletes it", async () => {
  const { env, sqlite } = await freshEnv();
  await db.saveBulkConfirmation(env, preview({ expiresAt: Date.now() - 1 }));
  assert.equal(await db.takeBulkConfirmation(env, check()), null);
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
