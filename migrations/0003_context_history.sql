-- Each accepted version of the context notes of an account, and each change that an agent
-- proposed and that waits for a decision. The accepted rows, in the order of decided_at, are the
-- history. accounts.context holds the text of the latest accepted row. Mailroom deletes a
-- proposal when the user rejects it.
CREATE TABLE context_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  context TEXT NOT NULL,
  -- 'proposed' or 'accepted'. A change by the user is accepted when it is saved.
  status TEXT NOT NULL,
  -- 'user' or 'agent'
  author_kind TEXT NOT NULL,
  -- The email address of the user, or the name of the OAuth client of the agent.
  author TEXT NOT NULL,
  -- The OAuth client ID of the agent.
  client_id TEXT,
  -- A name and a reason that the agent gave. Mailroom cannot verify them.
  agent_label TEXT,
  reason TEXT,
  -- The accepted version that was current when the agent proposed this change.
  base_id INTEGER,
  -- The version that the user restored to make this version.
  restored_from INTEGER,
  created_at INTEGER NOT NULL,
  -- When the change became current.
  decided_at INTEGER,
  -- The email address of the user who saved or accepted the change.
  decided_by TEXT
);

CREATE INDEX context_versions_account ON context_versions (account_id, status, decided_at);

-- Before this migration, only the user could change the context.
INSERT INTO context_versions (account_id, context, status, author_kind, author, created_at, decided_at, decided_by)
SELECT a.id, a.context, 'accepted', 'user', COALESCE(u.email, ''), a.updated_at, a.updated_at, u.email
FROM accounts a LEFT JOIN users u ON u.id = a.user_id
WHERE a.context != '';
