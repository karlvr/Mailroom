-- The previews of the bulk thread tools that wait for the agent to confirm them. A preview holds the
-- threads that it showed, and a confirmation changes only those threads. Each preview works once,
-- and only until it expires. Mailroom deletes expired previews when it saves a new one.
CREATE TABLE bulk_confirmations (
  -- The SHA-256 of the confirmation token, in base64url. Mailroom does not store the token itself.
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- The tool and its arguments, as JSON. A confirmation must give the same tool and arguments.
  action TEXT NOT NULL,
  -- The IDs of the threads that the preview showed, as a JSON array.
  thread_ids TEXT NOT NULL,
  -- The time when the preview expires, in milliseconds since the epoch.
  expires_at INTEGER NOT NULL
);
