-- A preview of a bulk thread tool now holds the messages that it saw in each thread. A confirmation
-- changes only those messages, so a message that arrives in a thread after the preview does not
-- change. A preview waits at most 10 minutes, so the migration deletes the waiting previews instead
-- of converting them. An agent that confirms one of them gets a new preview.
DROP TABLE bulk_confirmations;

CREATE TABLE bulk_confirmations (
  -- The SHA-256 of the confirmation token, in base64url. Mailroom does not store the token itself.
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- The tool and its arguments, as JSON. A confirmation must give the same tool and arguments.
  action TEXT NOT NULL,
  -- The threads that the preview showed, each with the IDs of the messages that the preview saw in it, as JSON.
  threads TEXT NOT NULL,
  -- The time when the preview expires, in milliseconds since the epoch.
  expires_at INTEGER NOT NULL
);
