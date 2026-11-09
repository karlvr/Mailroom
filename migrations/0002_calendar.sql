-- The Google permissions that the stored refresh token grants, separated by spaces.
-- NULL for an account that was linked before Mailroom recorded permissions.
ALTER TABLE accounts ADD COLUMN scopes TEXT;
ALTER TABLE accounts ADD COLUMN allow_invite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN allow_reply INTEGER NOT NULL DEFAULT 0;
