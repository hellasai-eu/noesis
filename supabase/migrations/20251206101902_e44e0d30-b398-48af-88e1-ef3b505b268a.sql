
-- Fix security definer view issue by recreating as regular view with SECURITY INVOKER
DROP VIEW IF EXISTS public.question_vote_stats;

CREATE VIEW public.question_vote_stats 
WITH (security_invoker = true)
AS
SELECT 
  question_id,
  COUNT(*) FILTER (WHERE vote_type = 'up') as upvote_count,
  COUNT(*) FILTER (WHERE vote_type = 'down') as downvote_count
FROM public.question_votes
GROUP BY question_id;
