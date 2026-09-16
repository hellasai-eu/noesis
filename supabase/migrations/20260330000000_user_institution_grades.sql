-- Junction table for instructor multi-grade assignments
-- Students continue using user_institutions.grade_level (single value)
-- Instructors use this table for multiple grade assignments

CREATE TABLE public.user_institution_grades (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_institution_id uuid NOT NULL REFERENCES public.user_institutions(id) ON DELETE CASCADE,
  grade_level text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_institution_id, grade_level),
  CHECK (grade_level IN (
    'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
    'gymnasio_1','gymnasio_2','gymnasio_3',
    'lykeio_1','lykeio_2','lykeio_3'
  ))
);

-- Index for efficient lookups by user_institution_id
CREATE INDEX idx_user_institution_grades_ui_id ON user_institution_grades(user_institution_id);

-- RLS policies (mirror user_institutions patterns)
ALTER TABLE user_institution_grades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own grades"
  ON user_institution_grades FOR SELECT
  USING (user_institution_id IN (
    SELECT id FROM user_institutions WHERE user_id = auth.uid()
  ));

CREATE POLICY "Admins can manage grades"
  ON user_institution_grades FOR ALL
  USING (user_institution_id IN (
    SELECT id FROM user_institutions WHERE is_institution_admin(auth.uid(), institution_id)
  ));
