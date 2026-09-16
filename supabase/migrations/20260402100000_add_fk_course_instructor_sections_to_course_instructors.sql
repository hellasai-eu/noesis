-- Add composite FK from course_instructor_sections to course_instructors
-- so that removing an instructor cascades and deletes their section restrictions.
-- This prevents orphaned restriction rows from silently re-activating if the
-- same user is later re-added as an instructor.

ALTER TABLE public.course_instructor_sections
  ADD CONSTRAINT fk_course_instructor_sections_instructor
  FOREIGN KEY (course_id, user_id)
  REFERENCES course_instructors(course_id, user_id)
  ON DELETE CASCADE;
