-- 1 when the owner allows agents to send replies from this mailbox to the people of the message that
-- each reply answers, otherwise 0. allow_send allows every message, so it includes this permission.
-- allow_reply is the permission for RSVPs to calendar invitations.
ALTER TABLE accounts ADD COLUMN allow_reply_email INTEGER NOT NULL DEFAULT 0;
