-- Table for global default prompt references
CREATE TABLE public.prompt_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  openai_prompt_id TEXT, -- NULL means use hardcoded/OpenAI default
  version TEXT DEFAULT 'default', -- 'default' means latest/default version
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table for institution-specific prompt overrides
CREATE TABLE public.institution_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  prompt_key TEXT NOT NULL,
  openai_prompt_id TEXT NOT NULL,
  version TEXT DEFAULT 'default',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(institution_id, prompt_key)
);

-- Enable RLS
ALTER TABLE public.prompt_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.institution_prompts ENABLE ROW LEVEL SECURITY;

-- RLS for prompt_defaults: Only super admins can manage
CREATE POLICY "Super admins can view prompt defaults"
ON public.prompt_defaults FOR SELECT
USING (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can insert prompt defaults"
ON public.prompt_defaults FOR INSERT
WITH CHECK (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can update prompt defaults"
ON public.prompt_defaults FOR UPDATE
USING (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can delete prompt defaults"
ON public.prompt_defaults FOR DELETE
USING (is_super_admin(auth.uid()));

-- RLS for institution_prompts: Super admins can manage all
CREATE POLICY "Super admins can view institution prompts"
ON public.institution_prompts FOR SELECT
USING (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can insert institution prompts"
ON public.institution_prompts FOR INSERT
WITH CHECK (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can update institution prompts"
ON public.institution_prompts FOR UPDATE
USING (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can delete institution prompts"
ON public.institution_prompts FOR DELETE
USING (is_super_admin(auth.uid()));

-- Triggers for updated_at
CREATE TRIGGER update_prompt_defaults_updated_at
BEFORE UPDATE ON public.prompt_defaults
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_institution_prompts_updated_at
BEFORE UPDATE ON public.institution_prompts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed initial prompt keys
INSERT INTO public.prompt_defaults (prompt_key, display_name, description) VALUES
  ('mcq_generation', 'MCQ Generation', 'Multiple choice question generation prompt'),
  ('student_mcq_generation', 'Student MCQ Generation', 'Student-facing MCQ generation prompt'),
  ('open_question_generation', 'Open Question Generation', 'Open-ended question generation prompt'),
  ('cheatsheet_generation', 'Cheatsheet Generation', 'Chapter cheatsheet generation prompt'),
  ('flashcard_generation', 'Flashcard Generation', 'Flashcard generation prompt'),
  ('study_tutor', 'Study Tutor', 'Interactive study session tutor prompt'),
  ('socratic_chat', 'Socratic Chat', 'Socratic method tutoring prompt'),
  ('socratic_chat_exercise', 'Socratic Chat (Exercise PDF)', 'Socratic tutoring for PDF exercises'),
  ('grading', 'Grading', 'Student interaction grading prompt'),
  ('student_evaluation', 'Student Evaluation', 'Student performance evaluation prompt'),
  ('chapter_detection', 'Chapter Detection', 'PDF chapter detection prompt'),
  ('similarity_check', 'Similarity Check', 'Question similarity detection prompt'),
  ('session_content', 'Session Content', 'Study session content curation prompt'),
  ('competency_extraction', 'Competency Extraction', 'Course competency extraction prompt'),
  ('instructor_copilot', 'Instructor Copilot', 'Instructor assistant copilot prompt');