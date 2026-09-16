-- Drop competency mastery tables (no longer used)
DROP TABLE IF EXISTS public.competency_mastery_history;
DROP TABLE IF EXISTS public.student_competency_mastery;

-- Drop tutor_state column from open_question_chats
ALTER TABLE public.open_question_chats DROP COLUMN IF EXISTS tutor_state;