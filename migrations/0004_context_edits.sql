-- The proposal that the user edited to make a version. The proposal stays in the history as an
-- accepted version just before the edited version.
ALTER TABLE context_versions ADD COLUMN edited_from INTEGER;

-- Browsers send the line breaks of a text box as CRLF, and agents send LF. Mailroom now stores LF
-- only, so that a diff does not show each line break as a change.
UPDATE accounts SET context = replace(context, char(13) || char(10), char(10)) WHERE instr(context, char(13)) > 0;
UPDATE context_versions SET context = replace(context, char(13) || char(10), char(10)) WHERE instr(context, char(13)) > 0;
