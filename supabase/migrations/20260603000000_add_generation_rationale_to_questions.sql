-- Add instructor-facing generation rationale to AI-generated questions.
-- A short paragraph (1-3 sentences) explaining which source input drove the
-- question and what concept or skill it tests. Visible only to instructors
-- and admins in the question tables; never shown to students.
-- NULL for legacy or user-created questions.

ALTER TABLE public.questions
  ADD COLUMN generation_rationale TEXT;

ALTER TABLE public.open_questions
  ADD COLUMN generation_rationale TEXT;

COMMENT ON COLUMN public.questions.generation_rationale IS
  'Instructor-facing explanation of why this question was generated (source input + concept tested). NULL for user-created or legacy questions.';

COMMENT ON COLUMN public.open_questions.generation_rationale IS
  'Instructor-facing explanation of why this question was generated (source input + concept tested). NULL for user-created or legacy questions.';
