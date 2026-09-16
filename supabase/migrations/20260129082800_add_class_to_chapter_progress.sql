-- Add class_id to course_chapter_progress to track progress per class instead of per course
ALTER TABLE course_chapter_progress
ADD COLUMN class_id uuid REFERENCES classes(id) ON DELETE CASCADE;

-- Drop the old unique constraint (course_id, chapter_id)
ALTER TABLE course_chapter_progress
DROP CONSTRAINT IF EXISTS course_chapter_progress_course_id_chapter_id_key;

-- Add new unique constraint (class_id, chapter_id)
ALTER TABLE course_chapter_progress
ADD CONSTRAINT course_chapter_progress_class_id_chapter_id_key UNIQUE (class_id, chapter_id);

-- Create index for faster lookups by class
CREATE INDEX IF NOT EXISTS idx_course_chapter_progress_class_id
ON course_chapter_progress(class_id);

-- Update RLS policies to include class_id checks
DROP POLICY IF EXISTS "Users can view chapter progress for their courses" ON course_chapter_progress;
DROP POLICY IF EXISTS "Instructors and admins can manage chapter progress" ON course_chapter_progress;

-- View policy: users can see progress for classes they have access to
CREATE POLICY "Users can view chapter progress for their classes"
ON course_chapter_progress
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM class_enrollments ce
    WHERE ce.class_id = course_chapter_progress.class_id
    AND ce.user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = course_chapter_progress.class_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR
  is_super_admin(auth.uid())
);

-- Manage policy: instructors and admins can update progress
CREATE POLICY "Instructors and admins can manage chapter progress"
ON course_chapter_progress
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM class_enrollments ce
    WHERE ce.class_id = course_chapter_progress.class_id
    AND ce.user_id = auth.uid()
    AND ce.role = 'instructor'
  )
  OR
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = course_chapter_progress.class_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR
  is_super_admin(auth.uid())
);
