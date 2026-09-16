-- ==============================================
-- RLS SECURITY AUDIT FIXES
-- ==============================================

-- 1. FIX: Remove policy that exposes ALL pending invitations to anyone
-- Issue: "Anyone can verify pending invitations by email" allows reading ALL pending invitations
-- Fix: Only allow users to see invitations for their own email
DROP POLICY IF EXISTS "Anyone can verify pending invitations by email" ON public.invitations;

-- 2. FIX: Profiles - Admins should only see profiles in their institution
-- Issue: Any admin can view ALL profiles across ALL institutions
-- Fix: Restrict to same institution only
DROP POLICY IF EXISTS "Admins can view profiles" ON public.profiles;

CREATE POLICY "Admins can view profiles in their institution"
ON public.profiles
FOR SELECT
USING (
  is_super_admin(auth.uid()) 
  OR (EXISTS (
    SELECT 1 FROM user_institutions ui1
    JOIN user_institutions ui2 ON ui1.institution_id = ui2.institution_id
    WHERE ui1.user_id = auth.uid() 
    AND ui1.role = 'admin'
    AND ui2.user_id = profiles.user_id
  ))
);

-- 3. FIX: user_tags - Any admin can manage ALL user tags across institutions
-- Issue: is_admin() checks if user is admin of ANY institution
-- Fix: Restrict to tags belonging to users in the same institution
DROP POLICY IF EXISTS "Admins can assign user tags" ON public.user_tags;
DROP POLICY IF EXISTS "Admins can remove user tags" ON public.user_tags;
DROP POLICY IF EXISTS "Admins can view user tags" ON public.user_tags;

CREATE POLICY "Admins can view user tags in their institution"
ON public.user_tags
FOR SELECT
USING (
  is_super_admin(auth.uid()) 
  OR user_id = auth.uid()
  OR (EXISTS (
    SELECT 1 FROM user_institutions ui1
    JOIN user_institutions ui2 ON ui1.institution_id = ui2.institution_id
    WHERE ui1.user_id = auth.uid() 
    AND ui1.role = 'admin'
    AND ui2.user_id = user_tags.user_id
  ))
);

CREATE POLICY "Admins can assign user tags in their institution"
ON public.user_tags
FOR INSERT
WITH CHECK (
  is_super_admin(auth.uid()) 
  OR (EXISTS (
    SELECT 1 FROM user_institutions ui1
    JOIN user_institutions ui2 ON ui1.institution_id = ui2.institution_id
    WHERE ui1.user_id = auth.uid() 
    AND ui1.role = 'admin'
    AND ui2.user_id = user_tags.user_id
  ))
);

CREATE POLICY "Admins can remove user tags in their institution"
ON public.user_tags
FOR DELETE
USING (
  is_super_admin(auth.uid()) 
  OR (EXISTS (
    SELECT 1 FROM user_institutions ui1
    JOIN user_institutions ui2 ON ui1.institution_id = ui2.institution_id
    WHERE ui1.user_id = auth.uid() 
    AND ui1.role = 'admin'
    AND ui2.user_id = user_tags.user_id
  ))
);

-- Also remove the duplicate "Users can view their own tag access" since it's now covered
DROP POLICY IF EXISTS "Users can view their own tag access" ON public.user_tags;

-- 4. FIX: question_votes - Any admin can view ALL votes across institutions
-- Issue: is_admin() allows any admin to see all votes
-- Fix: Restrict to same institution via course relationship
DROP POLICY IF EXISTS "Admins can view all votes" ON public.question_votes;

CREATE POLICY "Admins can view votes in their institution"
ON public.question_votes
FOR SELECT
USING (
  is_super_admin(auth.uid()) 
  OR user_id = auth.uid()
  OR (EXISTS (
    SELECT 1 
    FROM questions q
    JOIN courses c ON q.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = question_votes.question_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  ))
);

-- Also remove the redundant "Users can view their own votes" since it's now combined
DROP POLICY IF EXISTS "Users can view their own votes" ON public.question_votes;

-- 5. FIX: quiz_answers - Instructors should be able to view student answers in their courses
-- Issue: Only admins can view all quiz answers, instructors are excluded
-- Fix: Allow instructors with course access to view quiz answers
DROP POLICY IF EXISTS "Admins can view all quiz answers" ON public.quiz_answers;

CREATE POLICY "Admins and instructors can view quiz answers"
ON public.quiz_answers
FOR SELECT
USING (
  user_id = auth.uid()
  OR is_super_admin(auth.uid()) 
  OR (EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = quiz_answers.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  ))
);

-- Also remove the redundant user view policy since it's combined
DROP POLICY IF EXISTS "Users can view their own quiz answers" ON public.quiz_answers;

-- 6. FIX: quiz_answers delete - also add instructor access
DROP POLICY IF EXISTS "Admins can delete quiz answers" ON public.quiz_answers;

CREATE POLICY "Admins and instructors can delete quiz answers"
ON public.quiz_answers
FOR DELETE
USING (
  is_super_admin(auth.uid()) 
  OR (EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = quiz_answers.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  ))
);