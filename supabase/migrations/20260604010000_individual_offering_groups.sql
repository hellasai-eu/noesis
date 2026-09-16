-- Hidden singleton "individual" offering groups (issue #521).
--
-- Lets per-student targeting reuse the existing offering_groups infrastructure
-- (assignment + RLS + visibility) by lazily creating an is_individual = true
-- group per (offering, student).

ALTER TABLE public.offering_groups
  ADD COLUMN is_individual boolean NOT NULL DEFAULT false;

ALTER TABLE public.offering_groups
  ADD COLUMN owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.offering_groups
  ADD CONSTRAINT offering_groups_owner_requires_individual
  CHECK (owner_user_id IS NULL OR is_individual);

-- At most one singleton group per (offering, student).
CREATE UNIQUE INDEX offering_groups_individual_unique
  ON public.offering_groups (offering_id, owner_user_id)
  WHERE is_individual = true;
