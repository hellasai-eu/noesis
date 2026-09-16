-- Fix RLS policy for offerings table to allow instructors to attach courses
-- Issues addressed:
-- 1. class_id reference was ambiguous in the WITH CHECK clause
-- 2. is_class_instructor function needs to be more robust

-- Recreate is_class_instructor function with explicit auth.uid() handling
CREATE OR REPLACE FUNCTION public.is_class_instructor(_class_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM class_enrollments
    WHERE class_id = _class_id
      AND user_id = _user_id
      AND role = 'instructor'
  );
END;
$$;

-- Drop the existing policy
DROP POLICY IF EXISTS "Managers can manage offerings" ON public.offerings;

-- Recreate with explicit table reference for class_id
CREATE POLICY "Managers can manage offerings" ON public.offerings FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = offerings.class_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_class_instructor(offerings.class_id)
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = offerings.class_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_class_instructor(offerings.class_id)
  );
