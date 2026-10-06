-- Stringline is free. There are no paid plans.
--
-- The limit columns stay, because a self-hoster may still want to cap their own
-- instance, and `checkCompanyLimit` is the place to do it. What changes is the
-- default: a new company is not throttled into buying something that is not for
-- sale.
--
-- The Stripe columns are dropped rather than left lying around. No billing code
-- was ever written against them, and a dormant `stripe_customer_id` invites
-- someone to assume there is a payment path that does not exist.
--
-- Order matters below: the old CHECK constraint permits only the paid plan
-- names, so it has to go before anything writes 'free'.

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_check;

ALTER TABLE companies
  ALTER COLUMN max_projects SET DEFAULT 1000000,
  ALTER COLUMN max_planners SET DEFAULT 1000000,
  ALTER COLUMN plan         SET DEFAULT 'free',
  ALTER COLUMN status       SET DEFAULT 'active';

-- Existing companies were created under trial defaults; lift them too.
UPDATE companies
   SET max_projects  = 1000000,
       max_planners  = 1000000,
       plan          = 'free',
       status        = CASE WHEN status = 'trial' THEN 'active' ELSE status END,
       trial_ends_at = NULL;

ALTER TABLE companies ADD CONSTRAINT companies_plan_check
  CHECK (plan IN ('free', 'partner'));

ALTER TABLE companies
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;

DROP TABLE IF EXISTS billing_events;
