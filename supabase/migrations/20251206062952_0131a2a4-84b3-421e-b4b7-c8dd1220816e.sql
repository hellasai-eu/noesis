-- Add quiz_id column to quiz_answers (nullable for backward compatibility)
ALTER TABLE public.quiz_answers 
ADD COLUMN quiz_id uuid REFERENCES public.quizzes(id) ON DELETE SET NULL;

-- Add session_id for self-quizzes (generated on the fly)
ALTER TABLE public.quiz_answers 
ADD COLUMN session_id uuid;

-- Drop the old unique constraint
ALTER TABLE public.quiz_answers 
DROP CONSTRAINT IF EXISTS quiz_answers_user_id_question_id_key;

-- Add new unique constraint that includes session_id
ALTER TABLE public.quiz_answers 
ADD CONSTRAINT quiz_answers_user_question_session_key 
UNIQUE (user_id, question_id, session_id);

-- Add index for quiz_id lookups
CREATE INDEX idx_quiz_answers_quiz_id ON public.quiz_answers(quiz_id);

-- Add index for session_id lookups
CREATE INDEX idx_quiz_answers_session_id ON public.quiz_answers(session_id);