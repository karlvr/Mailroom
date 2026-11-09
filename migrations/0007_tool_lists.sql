-- The tool list that each Claude connection of a user loaded last. A connection is one OAuth client
-- of the user. Claude keeps the tool list from the time that it connected, so a connection with an
-- old fingerprint does not have the current tools until the user reconnects it.
CREATE TABLE tool_lists (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  -- The fingerprint of the server instructions and the tool list that the connection loaded.
  fingerprint TEXT NOT NULL,
  listed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
