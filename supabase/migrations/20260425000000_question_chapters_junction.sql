-- Replace material_references JSONB with relational junction tables

CREATE TABLE public.question_chapters (
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, chapter_id)
);

CREATE TABLE public.open_question_chapters (
  open_question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (open_question_id, chapter_id)
);

ALTER TABLE public.question_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_question_chapters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view question chapters for accessible courses"
ON public.question_chapters
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_chapters.question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage question chapters"
ON public.question_chapters
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_chapters.question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Users can view open question chapters for accessible courses"
ON public.open_question_chapters
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.open_questions oq
    JOIN public.courses c ON oq.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE oq.id = open_question_chapters.open_question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage open question chapters"
ON public.open_question_chapters
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.open_questions oq
    JOIN public.courses c ON oq.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE oq.id = open_question_chapters.open_question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

CREATE INDEX idx_question_chapters_question_id ON public.question_chapters(question_id);
CREATE INDEX idx_question_chapters_chapter_id ON public.question_chapters(chapter_id);
CREATE INDEX idx_open_question_chapters_open_question_id ON public.open_question_chapters(open_question_id);
CREATE INDEX idx_open_question_chapters_chapter_id ON public.open_question_chapters(chapter_id);

-- Drop the denormalized JSONB columns. Existing associations are intentionally
-- dropped per issue #370 — new questions will populate the junction tables.
ALTER TABLE public.questions DROP COLUMN IF EXISTS material_references;
ALTER TABLE public.open_questions DROP COLUMN IF EXISTS material_references;
