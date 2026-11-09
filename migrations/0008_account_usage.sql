-- The tool calls of agents in each account, counted for each UTC day. When an account gets a call,
-- Mailroom deletes the days of that account that are before the usage window. Thus an account that no
-- agent uses keeps the time of its last call.
CREATE TABLE account_usage (
  account_id TEXT NOT NULL,
  -- The UTC date, for example '2026-11-10'.
  day TEXT NOT NULL,
  calls INTEGER NOT NULL,
  -- The calls that succeeded and are of a tool that can change data, for example to label, draft or send email.
  changes INTEGER NOT NULL,
  -- The time of the latest call on the day.
  last_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);
