-- Team: password recovery and invites.
--
-- Stringline's promise against Procore is free unlimited field and client
-- seats. Until now none of it was reachable — the roles, the invites table and
-- the client-view endpoint all existed, but there was no way to add a second
-- person to a company.

-- ── Password reset ──────────────────────────────────────────────────────────

CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The token is never stored, only its SHA-256. A leaked database backup
  -- should not hand someone a working reset link for every account in it.
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);

-- Supports the per-account rate limit, which counts recent requests.
CREATE INDEX password_reset_created_idx ON password_reset_tokens (created_at);

-- ── Invites ─────────────────────────────────────────────────────────────────

-- Who sent it, so the Team screen can say. ON DELETE SET NULL because removing
-- someone from the company must not delete the invites they sent.
ALTER TABLE invites ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Optional display name, so an invite can be addressed to a person rather than
-- an address.
ALTER TABLE invites ADD COLUMN name TEXT;

-- Revoking is distinct from expiring: a revoked invite was deliberately killed,
-- and the Team screen should say so rather than claim it timed out.
ALTER TABLE invites ADD COLUMN revoked_at TIMESTAMPTZ;

CREATE INDEX invites_company_idx ON invites (company_id);

-- One live invite per address per company. Partial, so the same address can be
-- invited again after an earlier invite is accepted or revoked — which is the
-- normal case when someone loses their code.
CREATE UNIQUE INDEX invites_one_pending_per_email
  ON invites (company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
