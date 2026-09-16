-- Restrict `failed_login_attempts` reads to super admins.
--
-- 20260729000000 shipped the table with a second SELECT policy letting an
-- institution admin read the attempts attributable to their own institution.
-- That is being withdrawn, and it is worth being precise about why, because
-- the tenant-isolation reasoning in the original migration was sound — it is
-- the premise underneath it that does not hold.
--
-- Rows in this table are SELF-REPORTED by our own UI through the
-- `record-login-attempt` edge function. That endpoint cannot be authenticated:
-- it is called at the moment authentication has just failed, so there is no
-- credential to present, and GoTrue issues no signed proof that a sign-in was
-- even attempted. Anyone who can reach it can therefore submit any address and
-- have a row attributed to that user and institution. An isolate-wide cap
-- bounds the volume of such rows; nothing makes any one of them true.
--
-- So the question is not "may an institution admin see their own tenant's
-- attempts" — it is "what does an institution admin do with a forgeable claim
-- that a named user is under attack". The plausible answers are all bad: lock
-- the account, reset a password, confront a student. An attacker who wants any
-- of those outcomes only has to POST the right email a few dozen times. The
-- audience is what turns forgeable data into a lever, so the audience is now
-- limited to super admins — us — who have this migration and the trust note in
-- 20260729000000 to read alongside it.
--
-- `institution_id` and its index are KEPT. The column is still populated and
-- still meaningful: it is how a super admin would filter to one school when
-- triaging, and it is the seam a scoped policy would be rebuilt on if the
-- reports ever become trustworthy (which means routing sign-in through an edge
-- function so the server observes outcomes itself, rather than being told).

DROP POLICY IF EXISTS "Institution admins can read their failed login attempts"
  ON public.failed_login_attempts;

-- The super-admin SELECT policy from 20260729000000 is unchanged and is now
-- the only read path. There is still no INSERT/UPDATE/DELETE policy: writes
-- come solely from the edge function via the service role, which bypasses RLS.

COMMENT ON TABLE public.failed_login_attempts IS
  'Failed sign-in attempts SELF-REPORTED by our own UI via the record-login-attempt edge function. Unverified in both directions: an attacker calling GoTrue directly never appears here, and the reporting endpoint is necessarily unauthenticated so rows can be forged against any address. SUPER-ADMIN READ ONLY — institution admins deliberately cannot read it, because acting on a forgeable claim (lockout, password reset, confronting a student) is exactly the lever an attacker would want. Operational triage for a human who knows this; never build enforcement on it. See 20260729000000 and 20260729110000.';
