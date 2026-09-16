-- Scope question_votes INSERT to the question's course.
--
-- The policy shipped in 20251206101851 was:
--
--   CREATE POLICY "Users can insert their own votes"
--     ON public.question_votes FOR INSERT
--     WITH CHECK (user_id = auth.uid());
--
-- It constrains *whose* vote you may cast but not *what* you may vote on, so
-- any authenticated user could insert a vote row for any question id at all —
-- including questions belonging to another institution — simply by knowing or
-- guessing the uuid. Vote counts feed the question-quality signals, so this is
-- a cross-tenant write into another institution's data.
--
-- Two conditions are added:
--   1. the voter must be able to access the question's course
--      (`user_can_access_course` = super-admin / institution admin / course
--      instructor / enrolled student — the same set that can read the
--      question), and
--   2. evaluators assigned to review that course may not vote in it.
--      Evaluators (#667) are reviewers: their judgment belongs in
--      `question_evaluations`, and letting it double-count as a community vote
--      would skew the very signal they are reviewing.
--
-- The check goes through a SECURITY DEFINER helper. A bare subquery such as
-- `(SELECT course_id FROM questions WHERE id = question_id)` inside a policy is
-- evaluated with the caller's own RLS applied, which makes the policy behave
-- differently depending on what the caller happens to be able to read.
--
-- The helper answers the whole question as a boolean and resolves the actor
-- from auth.uid() rather than a parameter. Every SECURITY DEFINER function in
-- `public` is also reachable as a PostgREST RPC, so a helper shaped as
-- `get_question_course_id(uuid) RETURNS uuid` would hand any authenticated
-- caller the course of any question — and confirm the question exists — for
-- free. This shape discloses nothing a caller does not already know about
-- itself.
CREATE OR REPLACE FUNCTION public.can_vote_on_question(_question_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.questions q
    WHERE q.id = _question_id
      AND public.user_can_access_course(q.course_id, auth.uid())
      AND NOT public.is_course_evaluator(q.course_id, auth.uid())
  )
$$;

REVOKE ALL ON FUNCTION public.can_vote_on_question(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_vote_on_question(uuid)
  TO authenticated, service_role;

DROP POLICY IF EXISTS "Users can insert their own votes" ON public.question_votes;

CREATE POLICY "Users can insert their own votes"
ON public.question_votes
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND public.can_vote_on_question(question_id)
);
