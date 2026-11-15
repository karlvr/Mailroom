-- 1 when the owner allows agents to make links that download the attachments of this mailbox,
-- otherwise 0. Anyone who has such a link can download the attachment until the link expires.
ALTER TABLE accounts ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 0;

-- The links that download one attachment each. A link works until it expires, and only while the
-- owner allows download links for the mailbox. Mailroom deletes expired links when it saves a new one.
CREATE TABLE attachment_links (
  -- The SHA-256 of the token in the link, in base64url. Mailroom does not store the token itself.
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- The Gmail message and the part of the message with the attachment.
  message_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  -- The time when the link expires, in milliseconds since the epoch.
  expires_at INTEGER NOT NULL
);
