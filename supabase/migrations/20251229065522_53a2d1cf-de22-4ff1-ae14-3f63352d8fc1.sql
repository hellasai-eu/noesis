-- Phase 1: Class Abstraction Database Schema

-- ==========================================
-- 1. CREATE CORE TABLES
-- ==========================================

-- Classes table (cohorts/sections)
CREATE TABLE public.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name text NOT NULL,
  academic_period text,
  is_active boolean DEFAULT true,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Class enrollments (composite PK)
CREATE TABLE public.class_enrollments (
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('student', 'instructor')),
  enrolled_at timestamptz DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);

-- Offerings (course delivery to a class)
CREATE TABLE public.offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  start_date date,
  end_date date,
  is_active boolean DEFAULT true,
  leaderboard_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (class_id, course_id)
);

-- Quiz scheduling per offering
CREATE TABLE public.offering_quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  due_date timestamptz,
  published_at timestamptz,
  time_limit_override integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (offering_id, quiz_id)
);

-- Quiz session questions snapshot table
CREATE TABLE public.quiz_session_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL,
  question_snapshot jsonb NOT NULL,
  order_num integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ==========================================
-- 2. CREATE PERFORMANCE INDEXES
-- ==========================================

CREATE INDEX classes_institution_idx ON public.classes(institution_id);
CREATE INDEX classes_is_active_idx ON public.classes(is_active);
CREATE INDEX class_enrollments_user_idx ON public.class_enrollments(user_id);
CREATE INDEX class_enrollments_class_role_idx ON public.class_enrollments(class_id, role);
CREATE INDEX offerings_class_idx ON public.offerings(class_id);
CREATE INDEX offerings_course_idx ON public.offerings(course_id);
CREATE INDEX offering_quizzes_offering_idx ON public.offering_quizzes(offering_id);
CREATE INDEX offering_quizzes_published_idx ON public.offering_quizzes(offering_id, published_at, due_date);
CREATE INDEX quiz_session_questions_session_idx ON public.quiz_session_questions(session_id);

-- ==========================================
-- 3. CREATE HELPER FUNCTIONS (Security Definer)
-- ==========================================

-- Check if current user is enrolled in a class
CREATE OR REPLACE FUNCTION public.is_class_member(_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM class_enrollments
    WHERE class_id = _class_id AND user_id = auth.uid()
  )
$$;

-- Check if current user is a class instructor
CREATE OR REPLACE FUNCTION public.is_class_instructor(_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM class_enrollments
    WHERE class_id = _class_id AND user_id = auth.uid() AND role = 'instructor'
  )
$$;

-- Check if current user has access to an offering
CREATE OR REPLACE FUNCTION public.has_offering_access(_offering_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM offerings o
    JOIN classes c ON o.class_id = c.id
    WHERE o.id = _offering_id
    AND (
      is_super_admin(auth.uid())
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR is_class_member(o.class_id)
    )
  )
$$;

-- Check if current user can manage an offering
CREATE OR REPLACE FUNCTION public.can_manage_offering(_offering_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM offerings o
    JOIN classes c ON o.class_id = c.id
    WHERE o.id = _offering_id
    AND (
      is_super_admin(auth.uid())
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR is_class_instructor(o.class_id)
    )
  )
$$;

-- ==========================================
-- 4. ADD NULLABLE offering_id TO EXISTING TABLES
-- ==========================================

-- Session/transient tables: ON DELETE SET NULL
ALTER TABLE public.quiz_sessions ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE SET NULL;
ALTER TABLE public.open_question_progress ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE SET NULL;
ALTER TABLE public.student_study_progress ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE SET NULL;
ALTER TABLE public.flashcard_sessions ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE SET NULL;

-- Audit/history tables: ON DELETE RESTRICT
ALTER TABLE public.quiz_answers ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE RESTRICT;
ALTER TABLE public.student_competency_mastery ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE RESTRICT;
ALTER TABLE public.open_question_grades ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE RESTRICT;
ALTER TABLE public.student_evaluations ADD COLUMN offering_id uuid REFERENCES offerings(id) ON DELETE RESTRICT;

-- Indexes for offering_id columns
CREATE INDEX idx_quiz_sessions_offering ON public.quiz_sessions(offering_id);
CREATE INDEX idx_quiz_answers_offering ON public.quiz_answers(offering_id);
CREATE INDEX idx_student_mastery_offering ON public.student_competency_mastery(offering_id);
CREATE INDEX idx_oq_progress_offering ON public.open_question_progress(offering_id);
CREATE INDEX idx_oq_grades_offering ON public.open_question_grades(offering_id);
CREATE INDEX idx_student_study_progress_offering ON public.student_study_progress(offering_id);
CREATE INDEX idx_student_evals_offering ON public.student_evaluations(offering_id);
CREATE INDEX idx_flashcard_sessions_offering ON public.flashcard_sessions(offering_id);

-- ==========================================
-- 5. ENABLE RLS ON NEW TABLES
-- ==========================================

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offering_quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_session_questions ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- 6. RLS POLICIES FOR CLASSES
-- ==========================================

-- Admins can manage classes
CREATE POLICY "Admins can manage classes" ON public.classes FOR ALL
  USING (is_super_admin(auth.uid()) OR is_institution_admin(auth.uid(), institution_id))
  WITH CHECK (is_super_admin(auth.uid()) OR is_institution_admin(auth.uid(), institution_id));

-- Instructors can create classes in their institution
CREATE POLICY "Instructors can create classes" ON public.classes FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_institutions ui
    WHERE ui.user_id = auth.uid() 
    AND ui.institution_id = classes.institution_id 
    AND ui.role = 'instructor'
  ));

-- Class instructors can update their classes
CREATE POLICY "Class instructors can update" ON public.classes FOR UPDATE
  USING (is_class_instructor(id));

-- Institution members can view classes
CREATE POLICY "Institution members can view classes" ON public.classes FOR SELECT
  USING (user_belongs_to_institution(auth.uid(), institution_id));

-- ==========================================
-- 7. RLS POLICIES FOR CLASS ENROLLMENTS
-- ==========================================

-- Admins and class instructors can manage enrollments
CREATE POLICY "Admins and instructors manage enrollments" ON public.class_enrollments FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c 
      WHERE c.id = class_enrollments.class_id 
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_class_instructor(class_id)
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c 
      WHERE c.id = class_enrollments.class_id 
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_class_instructor(class_id)
  );

-- Class members can view roster
CREATE POLICY "Class members can view roster" ON public.class_enrollments FOR SELECT
  USING (is_class_member(class_id));

-- ==========================================
-- 8. RLS POLICIES FOR OFFERINGS
-- ==========================================

-- Managers can manage offerings
CREATE POLICY "Managers can manage offerings" ON public.offerings FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c 
      WHERE c.id = offerings.class_id 
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_class_instructor(class_id)
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c 
      WHERE c.id = offerings.class_id 
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_class_instructor(class_id)
  );

-- Class members can view offerings
CREATE POLICY "Class members can view offerings" ON public.offerings FOR SELECT
  USING (is_class_member(class_id));

-- ==========================================
-- 9. RLS POLICIES FOR OFFERING QUIZZES
-- ==========================================

-- Managers can manage offering quizzes
CREATE POLICY "Managers can manage offering quizzes" ON public.offering_quizzes FOR ALL
  USING (can_manage_offering(offering_id))
  WITH CHECK (can_manage_offering(offering_id));

-- Students see published quizzes
CREATE POLICY "Students see published quizzes" ON public.offering_quizzes FOR SELECT
  USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- ==========================================
-- 10. RLS POLICIES FOR QUIZ SESSION QUESTIONS
-- ==========================================

-- Users can view their session questions
CREATE POLICY "Users can view their session questions" ON public.quiz_session_questions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM quiz_sessions qs 
    WHERE qs.id = session_id AND qs.user_id = auth.uid()
  ));

-- Users can create their session questions
CREATE POLICY "Users can create their session questions" ON public.quiz_session_questions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM quiz_sessions qs 
    WHERE qs.id = session_id AND qs.user_id = auth.uid()
  ));

-- ==========================================
-- 11. UPDATE TRIGGERS FOR NEW TABLES
-- ==========================================

CREATE TRIGGER update_classes_updated_at
  BEFORE UPDATE ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_offerings_updated_at
  BEFORE UPDATE ON public.offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_offering_quizzes_updated_at
  BEFORE UPDATE ON public.offering_quizzes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();