-- The global context of each user. It applies to every account of the user. users.context holds
-- the text of the latest accepted version of the global context.
ALTER TABLE users ADD COLUMN context TEXT NOT NULL DEFAULT '';

-- The versions and the proposal of the global context are in context_versions, with the account_id
-- 'global:' followed by the user ID. Account IDs never contain ':'. The unique index
-- context_versions_one_proposal thus also allows one waiting proposal for the global context.
