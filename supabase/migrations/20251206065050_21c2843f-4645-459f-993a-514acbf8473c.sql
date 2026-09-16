-- Create a function to get vote counts for questions
CREATE OR REPLACE FUNCTION public.get_question_vote_counts(p_question_id uuid)
RETURNS TABLE(upvotes bigint, downvotes bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    COUNT(*) FILTER (WHERE vote_type = 'up') as upvotes,
    COUNT(*) FILTER (WHERE vote_type = 'down') as downvotes
  FROM public.question_votes
  WHERE question_id = p_question_id
$$;

-- Create a view for admins to see aggregated vote counts per question
CREATE OR REPLACE VIEW public.question_vote_stats AS
SELECT 
  question_id,
  COUNT(*) FILTER (WHERE vote_type = 'up') as upvote_count,
  COUNT(*) FILTER (WHERE vote_type = 'down') as downvote_count
FROM public.question_votes
GROUP BY question_id;