-- ============================================================================
-- Give the study-tutor sessions that already exist the offering they never got.
--
-- `chat_sessions.offering_id` is what the section-scoped write policies decide
-- on: `instructor_can_access_student_work` reads the offering when the row
-- names one, and where it does not, admits only an instructor holding no
-- `course_instructor_sections` rows for the course — an unattributed row has
-- not been shown to belong to any section, which is the #1097 semantic and is
-- not what is being revisited here.
--
-- What was wrong is that no study-tutor session ever named an offering. The
-- open-question surface resolves one (`verifyQuestionEnrollment` returns the
-- offering the question was published through) and `runChatTurn` stamps it on;
-- the study-session subject returned a course and nothing else, and the browser
-- created the row with `offering_id` unset. So every tutoring transcript on
-- that surface was unattributed, and a section-restricted instructor — the
-- ordinary case for a teacher who takes 1Α but not 1Β — could read it but
-- could not unpause it, delete it, or post into it. An institution admin could
-- do all three, because admins bypass both arms. That difference is the whole
-- bug report: "the instructor cannot unpause, the admin can".
--
-- The code fix scopes new sessions and repairs old ones on their next turn. It
-- cannot repair the ones that matter most, though — a session paused for review
-- takes no further turns until somebody unpauses it, which is precisely what
-- nobody can do. So the rows are repaired here.
--
-- The rule is the one `resolveStudySessionOffering` applies, stated in SQL:
-- among the offerings this study session is assigned to, in this session's own
-- course, take the one whose class the student is enrolled in. Where that
-- picks out exactly one offering it is the section the work belongs to; where
-- it picks out none (the student has left, or the session was never assigned)
-- or more than one (the student sits in two classes of the same course, both
-- assigned it), there is nothing in the data that says which section this is,
-- and the row stays unattributed rather than being guessed at.
-- ============================================================================

WITH scoped AS (
  SELECT
    s.id AS session_id,
    -- The `HAVING` below leaves exactly one, and `min(uuid)` is not an
    -- aggregate PostgreSQL has.
    (array_agg(DISTINCT o.id))[1] AS offering_id
  FROM public.chat_sessions s
  JOIN public.offering_study_sessions oss
    ON oss.study_session_id = s.study_session_id
  JOIN public.offerings o
    ON o.id = oss.offering_id
   AND o.course_id = s.course_id
  JOIN public.class_enrollments ce
    ON ce.class_id = o.class_id
   AND ce.user_id = s.user_id
   AND ce.role = 'student'
  WHERE s.study_session_id IS NOT NULL
    AND s.offering_id IS NULL
  GROUP BY s.id
  HAVING count(DISTINCT o.id) = 1
)
UPDATE public.chat_sessions s
SET offering_id = scoped.offering_id
FROM scoped
WHERE s.id = scoped.session_id;
