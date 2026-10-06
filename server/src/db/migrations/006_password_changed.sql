-- When a password was last changed.
--
-- Tokens are stateless JWTs with no revocation list, so without this a password
-- change would leave every previously-issued token valid — which defeats most
-- of the point of changing it. `authenticate` compares the token's `iat` against
-- this and rejects anything older, so changing a password signs out every other
-- session.

ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
