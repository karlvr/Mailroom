-- A confirmation of a bulk tool that works on a list of threads no longer needs to give the list
-- again. When it gives the list, the list must be the same as for the preview. listed is the SHA-256
-- of the sorted list as JSON, in base64url, and NULL for a tool that works by a search.
ALTER TABLE bulk_confirmations ADD COLUMN listed TEXT;
