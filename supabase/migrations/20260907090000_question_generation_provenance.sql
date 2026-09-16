-- Question generation provenance.
--
-- 1. `question_materials` — junction linking a question to the chapterless
--    "Other" materials it was generated from (#1019 made those materials
--    generation sources, but questions drawn from them carried no source link
--    at all, so the Question Bank's Book filter could never list them).
--    Mirrors `question_chapters` in shape and RLS.
--
-- 2. `questions.generated_for_group_id` — the student group (or the hidden
--    singleton group of an individually-targeted student) the batch was
--    generated for. Assignment (`offering_questions.group_id`) records where a
--    question is published NOW; this records who it was authored FOR, which
--    survives re-assignment.

CREATE TABLE public.question_materials (
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES public.course_materials(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, material_id)
);

ALTER TABLE public.question_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view question materials for accessible courses"
ON public.question_materials
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_materials.question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage question materials"
ON public.question_materials
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_materials.question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

CREATE INDEX idx_question_materials_question_id ON public.question_materials(question_id);
CREATE INDEX idx_question_materials_material_id ON public.question_materials(material_id);

ALTER TABLE public.questions
  ADD COLUMN generated_for_group_id UUID REFERENCES public.offering_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_questions_generated_for_group
  ON public.questions(generated_for_group_id)
  WHERE generated_for_group_id IS NOT NULL;
