ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS restrict_to_completed_chapters BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS student_generation_instructions TEXT DEFAULT NULL;
