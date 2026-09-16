-- Create question_votes table to track user votes
CREATE TABLE public.question_votes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  vote_type text NOT NULL CHECK (vote_type IN ('up', 'down')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);

-- Enable RLS
ALTER TABLE public.question_votes ENABLE ROW LEVEL SECURITY;

-- Users can view their own votes
CREATE POLICY "Users can view their own votes"
ON public.question_votes FOR SELECT
USING (user_id = auth.uid());

-- Users can insert their own votes
CREATE POLICY "Users can insert their own votes"
ON public.question_votes FOR INSERT
WITH CHECK (user_id = auth.uid());

-- Users can update their own votes
CREATE POLICY "Users can update their own votes"
ON public.question_votes FOR UPDATE
USING (user_id = auth.uid());

-- Users can delete their own votes
CREATE POLICY "Users can delete their own votes"
ON public.question_votes FOR DELETE
USING (user_id = auth.uid());

-- Index for fast lookups
CREATE INDEX idx_question_votes_user_question ON public.question_votes(user_id, question_id);
CREATE INDEX idx_question_votes_question ON public.question_votes(question_id);