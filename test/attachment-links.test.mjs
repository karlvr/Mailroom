// Tests the SQL of the download links and of the Allow download links setting in src/db.ts, with every
// migration applied to SQLite, the database engine of D1.
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

/** Returns an Env whose DB is a new SQLite database with every migration and one linked mailbox. */
const freshEnv = () => {
  const { env, sqlite } = sqliteEnv();
  insertRow(sqlite, "users", { id: "user-1", email: "me@example.com" });
  insertRow(sqlite, "accounts", { id: "acct-1", user_id: "user-1", email: "me@example.com" });
  return { env, sqlite };
};

const link = (over = {}) => ({ tokenHash: "hash-1", accountId: "acct-1", messageId: "m1", partId: "2", expiresAt: Date.now() + 600_000, ...over });

test("a link gives its attachment and its account, more than once", async () => {
  const { env } = freshEnv();
  await db.saveAttachmentLink(env, link());
  for (let i = 0; i < 2; i++) {
    const found = await db.findAttachmentLink(env, "hash-1");
    assert.equal(found.messageId, "m1");
    assert.equal(found.partId, "2");
    assert.equal(found.account.id, "acct-1");
    assert.equal(found.account.email, "me@example.com");
    assert.equal(found.account.allow_download, 0);
  }
  assert.equal(await db.findAttachmentLink(env, "hash-2"), null);
});

test("an expired link does not work, and a new link deletes it", async () => {
  const { env, sqlite } = freshEnv();
  await db.saveAttachmentLink(env, link({ expiresAt: Date.now() - 1 }));
  assert.equal(await db.findAttachmentLink(env, "hash-1"), null);
  await db.saveAttachmentLink(env, link({ tokenHash: "hash-2" }));
  assert.deepEqual(
    sqlite.prepare("SELECT token_hash FROM attachment_links").all().map((r) => r.token_hash),
    ["hash-2"],
  );
});

test("the owner can allow download links, and deleting the account deletes its links", async () => {
  const { env, sqlite } = freshEnv();
  const permissions = { sendEmail: false, replyEmail: false, sendInvitations: false, rsvp: false, download: true };
  await db.updateAccountDetails(env, "user-1", "acct-1", { name: "Work", context: "", permissions }, "me@example.com");
  await db.saveAttachmentLink(env, link());
  assert.equal(db.accountPermissions((await db.findAttachmentLink(env, "hash-1")).account).download, true);
  await db.deleteAccount(env, "user-1", "acct-1");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM attachment_links").get().n, 0);
});
