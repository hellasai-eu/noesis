-- The Student Chat History surface now speaks of "assessing" rather than
-- "grading" (PR #1302). The manual-override fallback feedback is stored
-- free text, so rows written before the rename would keep surfacing the
-- old wording in the assessment card and details dialog forever.
--
-- Exact-match only: real instructor-written feedback is never touched.
UPDATE public.open_question_grades
SET feedback = 'Manually assessed by instructor'
WHERE feedback = 'Manually graded by instructor';
