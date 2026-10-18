-- Hardening the way people get in, and keeping a record of it.
--
-- Two tables, with different jobs and different lifetimes.
--
--   * `login_attempts` is a short-lived throttle. It exists so that an
--     attacker who has a list of email addresses cannot sit there guessing.
--   * `auth_events` is the audit trail. It is what an owner reads when they
--     want to know who did what, and it is the only artefact that survives an
--     incident.

-- ── Throttling ───────────────────────────────────────────────────────────────
--
-- Keyed on the *identifier that was tried*, not on a user row, and that is the
-- whole point. Recording failures against `users` would mean a guess at an
-- address with no account leaves no trace and is never slowed down, so an
-- attacker learns which addresses exist purely from which ones start getting
-- locked. Here a nonexistent account throttles exactly like a real one.
--
-- `company_id` is nullable because the company code itself may be wrong, and
-- that attempt still deserves to be counted.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  -- Lower-cased at the call site, so the index is usable and "Kev@" and "kev@"
  -- cannot be used as two separate budgets.
  email       TEXT NOT NULL,
  ip          TEXT,
  succeeded   BOOLEAN NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The lookup the limiter does on every login: recent failures for this
-- identifier. Descending, because it only ever reads the newest.
CREATE INDEX IF NOT EXISTS idx_login_attempts_identity
  ON login_attempts (company_id, email, at DESC);

-- The second axis: one host spraying many addresses. Cheap to maintain and the
-- only way to see a spray, which per-account counting cannot.
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip
  ON login_attempts (ip, at DESC) WHERE ip IS NOT NULL;

-- For the prune. Without it, deleting old rows is a sequential scan of a table
-- that only ever grows.
CREATE INDEX IF NOT EXISTS idx_login_attempts_at ON login_attempts (at);

-- ── The audit trail ──────────────────────────────────────────────────────────
--
-- Every security-relevant act, with who did it and to whom. `actor_id` and
-- `user_id` are separate because the interesting events have two people in
-- them: an owner resetting a teammate's password is the owner acting on the
-- teammate, and a log that records only one of them answers neither "what did
-- she do" nor "what happened to him".
--
-- Both are ON DELETE SET NULL rather than CASCADE. Deleting a user must not
-- quietly erase the record of what they did — that is precisely the record
-- worth keeping.
CREATE TABLE IF NOT EXISTS auth_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  -- Denormalised on purpose: the name and email at the time it happened. A log
  -- that renders "(deleted user) changed a role" six months later has lost the
  -- thing being asked about.
  subject     TEXT,
  detail      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_company ON auth_events (company_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events (user_id, at DESC);

-- ── Lockout state ────────────────────────────────────────────────────────────
--
-- Carried on the user so that a lock survives the attempt rows being pruned,
-- and so an owner can see and clear it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
