-- Notes that agents keep between runs, for example what they already did. Each note belongs to the
-- global state of a user, or to one account of the user. A note expires, and Mailroom deletes the
-- expired notes of a user when an agent saves a note.
CREATE TABLE agent_state (
  user_id TEXT NOT NULL,
  -- The account of the note, or '' for the global state of the user.
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  -- 1 for a new note, and 1 more at each save. A save can require the version that the agent read.
  version INTEGER NOT NULL,
  -- The name of the OAuth client of the agent that saved the note last, and the name that the agent gave for itself.
  updated_by TEXT NOT NULL,
  agent_label TEXT,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_id, key)
);
