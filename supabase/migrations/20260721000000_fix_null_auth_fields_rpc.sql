-- Workaround for a GoTrue bug on Supabase preview branches where scanning an
-- auth.users row with ANY NULL character-varying token column crashes with:
--   "sql: Scan error on column index N: converting NULL to string is unsupported"
-- surfaced to the client as HTTP 500 {"code":"unexpected_failure",
-- "message":"Database error querying schema"}.
--
-- Used by seed-e2e-users.sh after creating users via the Admin API (which
-- leaves these token columns NULL). Setting them to '' is semantically
-- equivalent to NULL. It must cover every such column, not just
-- email_change/phone_change — the scan crashes on the first NULL it reaches,
-- so a partial fix only moves the crash to the next column.
--
-- Restricted to service_role only; never exposed to anon or authenticated.
CREATE OR REPLACE FUNCTION public.fix_null_auth_fields()
RETURNS void
SECURITY DEFINER
SET search_path = ''
LANGUAGE sql
AS $$
  -- Set EVERY character-varying token column GoTrue scans, not just
  -- email_change/phone_change — the row-scan crashes on the first NULL it
  -- hits, so a partial fix just moves the crash to the next column.
  UPDATE auth.users
  SET
    confirmation_token           = COALESCE(confirmation_token, ''),
    recovery_token               = COALESCE(recovery_token, ''),
    email_change                 = COALESCE(email_change, ''),
    email_change_token_new       = COALESCE(email_change_token_new, ''),
    email_change_token_current   = COALESCE(email_change_token_current, ''),
    phone_change                 = COALESCE(phone_change, ''),
    phone_change_token           = COALESCE(phone_change_token, ''),
    reauthentication_token       = COALESCE(reauthentication_token, '')
  WHERE confirmation_token IS NULL
     OR recovery_token IS NULL
     OR email_change IS NULL
     OR email_change_token_new IS NULL
     OR email_change_token_current IS NULL
     OR phone_change IS NULL
     OR phone_change_token IS NULL
     OR reauthentication_token IS NULL;
$$;

REVOKE ALL ON FUNCTION public.fix_null_auth_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fix_null_auth_fields() TO service_role;
