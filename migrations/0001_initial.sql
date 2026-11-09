CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  status_detail TEXT,
  allow_send INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, email)
);

CREATE INDEX accounts_user ON accounts (user_id);
