-- Course-level instructor assignment and academic year rollover
-- Part of issue #48

-- 1. New table: course_instructors (course-level instructor assignment)
CREATE TABLE public.course_instructors (
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);

ALTER TABLE public.course_instructors ENABLE ROW LEVEL SECURITY;

-- Index for looking up instructors by user
CREATE INDEX idx_course_instructors_user ON public.course_instructors(user_id);

-- RLS: Super admins and institution admins can manage course instructors
CREATE POLICY "Admins can manage course instructors"
  ON public.course_instructors FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_instructors.course_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_instructors.course_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
  );

-- RLS: Institution members can view course instructor assignments
CREATE POLICY "Institution members can view course instructors"
  ON public.course_instructors FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = course_instructors.course_id
      AND ui.user_id = auth.uid()
    )
  );

-- 2. New column: institutions.academic_period
ALTER TABLE public.institutions ADD COLUMN IF NOT EXISTS academic_period TEXT;
