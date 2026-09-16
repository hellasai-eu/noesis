-- Move the one bit of an MCQ answer key a student needs BEFORE answering out
-- of `answer_key` and into `payload` (#1011).
--
-- `renderQuestionStem` prepends "Select all that apply." when more than one
-- option is correct (#592). It derived that from `answer_key.correct_indices
-- .length`, which meant every answering surface had to fetch the whole answer
-- key just to size a hint — and the key then sat in the browser for the entire
-- time the student was answering.
--
-- Whether a question takes one answer or several is presentation: it is
-- printed on the question. WHICH options are right is the answer. Splitting
-- them lets the quiz and practice surfaces stop requesting `answer_key` until
-- the student has submitted, the same narrowing the study-guide player got in
-- #1116 (and which it achieved only by dropping the hint entirely).
--
-- The writers (`toMcqUnified`, both copies) now emit `multi_correct` on every
-- new MCQ. This backfills the rows that already exist, so a missing value
-- means "not an MCQ payload", never "not yet backfilled" — the reader can
-- treat absent as false without silently under-hinting old content.
--
-- Idempotent: re-running recomputes the same boolean from the same key, and
-- the final predicate makes a second run touch no rows at all.
--
-- The `updated_at` trigger is suspended for the backfill. `questions.updated_at`
-- means "when an instructor last changed this question" — it is shown to
-- instructors and is the row version `record_quiz_answers` compares to detect a
-- key edited mid-grading. Stamping every MCQ in the bank with today's date
-- would be a lie on the first count and noise on the second. The disable is
-- transactional (a migration runs in one), so it cannot leak past this file.

ALTER TABLE public.questions DISABLE TRIGGER update_questions_updated_at;

UPDATE public.questions
   SET payload = payload || jsonb_build_object(
         'multi_correct',
         COALESCE(jsonb_array_length(answer_key -> 'correct_indices'), 0) > 1
       )
 WHERE type = 'mcq'
   AND jsonb_typeof(payload) = 'object'
   -- Guard the `jsonb_array_length` above: a pre-#592 row whose key holds only
   -- the scalar `correct_index` is single-correct by construction, and a row
   -- with a malformed key has no defensible answer either way. Both are left
   -- without the field, which reads as false.
   AND jsonb_typeof(answer_key -> 'correct_indices') = 'array'
   AND (
     payload -> 'multi_correct' IS DISTINCT FROM
     to_jsonb(COALESCE(jsonb_array_length(answer_key -> 'correct_indices'), 0) > 1)
   );

ALTER TABLE public.questions ENABLE TRIGGER update_questions_updated_at;
