-- Exact session invalidation.
--
-- 006 compared a token's `iat` against `password_changed_at`, which needs a
-- slack window because `iat` only has one-second resolution — and that window
-- is precisely a hole: any token minted inside it survives the change. A
-- counter has no such ambiguity. Bump it and every token carrying the old value
-- is dead, whatever second it was issued in.
--
-- Tokens predating this column carry no version and are treated as 0, so
-- existing sessions stay valid until their password actually changes.

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
