-- Create study_sessions table for admin-created tutoring sessions
CREATE TABLE public.study_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  material_id uuid REFERENCES public.course_materials(id) ON DELETE SET NULL,
  chapter_id uuid REFERENCES public.material_chapters(id) ON DELETE SET NULL,
  title text NOT NULL,
  topic text,
  page_start integer,
  page_end integer,
  extracted_content text,
  is_published boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create student_study_progress table for tracking student sessions
CREATE TABLE public.student_study_progress (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  study_session_id uuid NOT NULL REFERENCES public.study_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_started',
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(study_session_id, user_id)
);

-- Create study_session_messages table for chat history
CREATE TABLE public.study_session_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  progress_id uuid NOT NULL REFERENCES public.student_study_progress(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_study_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_session_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for study_sessions
CREATE POLICY "Admins and instructors can manage study sessions"
ON public.study_sessions FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  is_institution_admin((SELECT institution_id FROM courses WHERE id = study_sessions.course_id), auth.uid()) OR
  is_course_instructor(course_id, auth.uid())
);

CREATE POLICY "Users can view published study sessions for accessible courses"
ON public.study_sessions FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  is_institution_admin((SELECT institution_id FROM courses WHERE id = study_sessions.course_id), auth.uid()) OR
  is_course_instructor(course_id, auth.uid()) OR
  (is_published = true AND user_has_course_tag_access(course_id, auth.uid()))
);

-- RLS policies for student_study_progress
CREATE POLICY "Users can manage their own progress"
ON public.student_study_progress FOR ALL
USING (user_id = auth.uid());

CREATE POLICY "Admins can view all progress in their courses"
ON public.student_study_progress FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = student_study_progress.course_id
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);

-- RLS policies for study_session_messages
CREATE POLICY "Users can manage their own messages"
ON public.study_session_messages FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM student_study_progress p
    WHERE p.id = study_session_messages.progress_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Admins can view messages"
ON public.study_session_messages FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM student_study_progress p
    JOIN courses c ON c.id = p.course_id
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE p.id = study_session_messages.progress_id
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);

-- Trigger for updated_at
CREATE TRIGGER update_study_sessions_updated_at
BEFORE UPDATE ON public.study_sessions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_student_study_progress_updated_at
BEFORE UPDATE ON public.student_study_progress
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();