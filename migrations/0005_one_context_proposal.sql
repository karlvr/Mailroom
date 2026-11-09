-- An account has at most one proposal that waits for a decision. A new proposal replaces it.
-- Keep the newest waiting proposal of each account.
DELETE FROM context_versions WHERE status = 'proposed' AND id NOT IN (
  SELECT MAX(id) FROM context_versions WHERE status = 'proposed' GROUP BY account_id
);
CREATE UNIQUE INDEX context_versions_one_proposal ON context_versions (account_id) WHERE status = 'proposed';
