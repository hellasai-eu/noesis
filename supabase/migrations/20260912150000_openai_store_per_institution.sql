-- Per-institution opt-in for OpenAI request retention.
--
-- Edge functions now send every OpenAI Responses call with `store: false` by
-- default (no retention in the OpenAI dashboard), because the OpenAI DPA and
-- zero-data-retention status are unconfirmed — see
-- docs/compliance/governance/open-items.md items 6-8. This flag is the single
-- opt-out from that default: when a SUPER-ADMIN turns it on for an
-- institution, that institution's requests are sent with `store: true` again
-- (e.g. to debug generation quality from the OpenAI dashboard).

ALTER TABLE public.institutions
  ADD COLUMN openai_store_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.institutions.openai_store_enabled IS
  'Super-admin-only: when true, OpenAI requests for this institution are sent with store:true (retained in the OpenAI dashboard). Default false = no retention. Guarded by trg_guard_openai_store_enabled.';

-- Institution admins can UPDATE their own institutions row ("Admins can update
-- their institution", 20251205125355), and any authenticated user can INSERT
-- one ("Authenticated users can create institutions", 20260104065140, WITH
-- CHECK (true)) — either path would let a non-super-admin set this flag
-- themselves. RLS is per-row, not per-column, so the column is guarded by a
-- trigger instead: only a super admin (or a service-role/SQL session, where
-- auth.uid() is NULL) may change it on UPDATE or set it true on INSERT. Anon
-- has neither an INSERT nor an UPDATE policy, so the NULL-uid carve-out does
-- not widen anon access.
CREATE OR REPLACE FUNCTION public.guard_openai_store_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (
       (TG_OP = 'INSERT' AND NEW.openai_store_enabled)
       OR (TG_OP = 'UPDATE' AND NEW.openai_store_enabled IS DISTINCT FROM OLD.openai_store_enabled)
     )
     AND auth.uid() IS NOT NULL
     AND NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only super admins can change OpenAI data retention'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_openai_store_enabled
  BEFORE INSERT OR UPDATE ON public.institutions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_openai_store_enabled();
