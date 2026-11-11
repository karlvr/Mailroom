// Tests the SQL of the agent state in src/db.ts, with every migration applied to SQLite, the database engine of D1.
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

const account = { kind: "account", accountId: "acct-1" };
const agent = { clientName: "Claude", label: "Morning briefing" };
const note = (key, value, over = {}) => ({ key, value, days: 90, agent, ...over });

test("a save makes a note, and a later save replaces its value and raises its version", async () => {
  const { env } = sqliteEnv();
  assert.deepEqual(await db.writeState(env, "user-1", account, note("briefing/last_run", "2026-11-12T07:00:00Z")), { version: 1 });
  assert.deepEqual(await db.writeState(env, "user-1", account, note("briefing/last_run", "2026-11-13T07:00:00Z")), { version: 2 });
  const [n] = await db.readState(env, "user-1", account);
  assert.equal(n.value, "2026-11-13T07:00:00Z");
  assert.equal(n.version, 2);
  assert.equal(n.updatedBy, "Claude");
  assert.equal(n.agentLabel, "Morning briefing");
  assert.ok(n.expiresAt > Date.now() + 89 * 86_400_000);
});

test("the global notes, the notes of each account and the notes of each user are apart", async () => {
  const { env } = sqliteEnv();
  await db.writeState(env, "user-1", account, note("k", "account"));
  await db.writeState(env, "user-1", db.GLOBAL_STATE, note("k", "global"));
  await db.writeState(env, "user-2", account, note("k", "other user"));
  assert.deepEqual((await db.readState(env, "user-1", account)).map((n) => n.value), ["account"]);
  assert.deepEqual((await db.readState(env, "user-1", db.GLOBAL_STATE)).map((n) => n.value), ["global"]);
  const all = await db.allState(env, "user-1");
  assert.deepEqual(all.global.map((n) => n.value), ["global"]);
  assert.deepEqual([...all.accounts].map(([id, notes]) => [id, notes.map((n) => n.value)]), [["acct-1", ["account"]]]);
});

test("reads only the keys or the prefix that the call gives", async () => {
  const { env } = sqliteEnv();
  for (const k of ["sent/t1", "sent/t2", "count"]) await db.writeState(env, "user-1", account, note(k, "x"));
  assert.deepEqual((await db.readState(env, "user-1", account, { prefix: "sent/" })).map((n) => n.key), ["sent/t1", "sent/t2"]);
  assert.deepEqual((await db.readState(env, "user-1", account, { keys: ["count", "nope"] })).map((n) => n.key), ["count"]);
});

test("if_version saves only over the version that the agent read", async () => {
  const { env } = sqliteEnv();
  assert.deepEqual(await db.writeState(env, "user-1", account, note("n", "1", { ifVersion: 0 })), { version: 1 });
  assert.equal(await db.writeState(env, "user-1", account, note("n", "again", { ifVersion: 0 })), "conflict");
  assert.deepEqual(await db.writeState(env, "user-1", account, note("n", "2", { ifVersion: 1 })), { version: 2 });
  assert.equal(await db.writeState(env, "user-1", account, note("n", "stale", { ifVersion: 1 })), "conflict");
  assert.equal(await db.writeState(env, "user-1", account, note("missing", "x", { ifVersion: 3 })), "conflict");
  assert.equal((await db.readState(env, "user-1", account, { keys: ["n"] }))[0].value, "2");
});

test("an expired note is not read, and a save deletes it", async () => {
  const { env, sqlite } = sqliteEnv();
  await db.writeState(env, "user-1", account, note("old", "x"));
  sqlite.prepare("UPDATE agent_state SET expires_at = ?").run(Date.now() - 1);
  assert.deepEqual(await db.readState(env, "user-1", account), []);
  assert.deepEqual(await db.writeState(env, "user-1", account, note("old", "new", { ifVersion: 0 })), { version: 1 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM agent_state").get().n, 1);
});

test("a scope holds at most MAX_STATE_NOTES notes, and a save of an existing key still works", async () => {
  const { env, sqlite } = sqliteEnv();
  const insert = sqlite.prepare(
    "INSERT INTO agent_state (user_id, account_id, key, value, version, updated_by, updated_at, expires_at) VALUES ('user-1', 'acct-1', ?, 'x', 1, 'Claude', 0, ?)",
  );
  for (let i = 0; i < db.MAX_STATE_NOTES; i++) insert.run(`k${i}`, Date.now() + 86_400_000);
  assert.equal(await db.writeState(env, "user-1", account, note("one-more", "x")), "full");
  assert.deepEqual(await db.writeState(env, "user-1", account, note("k0", "y")), { version: 2 });
  assert.deepEqual(await db.writeState(env, "user-1", db.GLOBAL_STATE, note("global", "x")), { version: 1 });
});

test("deletes notes by key, or every note of a scope", async () => {
  const { env } = sqliteEnv();
  for (const k of ["a", "b", "c"]) await db.writeState(env, "user-1", account, note(k, "x"));
  await db.writeState(env, "user-1", db.GLOBAL_STATE, note("g", "x"));
  assert.equal(await db.deleteState(env, "user-1", account, ["a", "nope"]), 1);
  assert.equal(await db.deleteState(env, "user-1", account, "all"), 2);
  assert.deepEqual((await db.readState(env, "user-1", db.GLOBAL_STATE)).map((n) => n.key), ["g"]);
});

test("deletes more keys than D1 binds in one statement", async () => {
  const { env, sqlite } = sqliteEnv();
  const insert = sqlite.prepare(
    "INSERT INTO agent_state (user_id, account_id, key, value, version, updated_by, updated_at, expires_at) VALUES ('user-1', 'acct-1', ?, 'x', 1, 'Claude', 0, ?)",
  );
  const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
  for (const k of keys) insert.run(k, Date.now() + 86_400_000);
  assert.equal(await db.deleteState(env, "user-1", account, [...keys, "nope"]), 250);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM agent_state").get().n, 0);
});

test("removing an account deletes its notes, and keeps the global notes", async () => {
  const { env, sqlite } = sqliteEnv();
  insertRow(sqlite, "users", { id: "user-1", email: "me@example.com" });
  insertRow(sqlite, "accounts", { id: "acct-1", user_id: "user-1", email: "me@example.com" });
  await db.writeState(env, "user-1", account, note("a", "x"));
  await db.writeState(env, "user-1", db.GLOBAL_STATE, note("g", "x"));
  await db.deleteAccount(env, "user-1", "acct-1");
  assert.deepEqual(sqlite.prepare("SELECT account_id, key FROM agent_state").all().map((r) => [r.account_id, r.key]), [["", "g"]]);
});
