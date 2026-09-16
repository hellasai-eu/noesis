-- Drop the security definer view and recreate with proper security
DROP VIEW IF EXISTS public.question_vote_stats;

-- Create the view with security invoker (default)
CREATE VIEW public.question_vote_stats 
WITH (security_invoker = true)
AS
SELECT 
  question_id,
  COUNT(*) FILTER (WHERE vote_type = 'up') as upvote_count,
  COUNT(*) FILTER (WHERE vote_type = 'down') as downvote_count
FROM public.question_votes
GROUP BY question_id;

-- Allow admins to see all votes for reporting
CREATE POLICY "Admins can view all votes"
ON public.question_votes FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'
  )
);