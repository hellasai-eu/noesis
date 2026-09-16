-- Add category column to classes table
-- NULL = default/regular category, non-null = named category (e.g., 'English', 'PT')
ALTER TABLE classes ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL;

-- Drop the old unique constraint
DROP INDEX IF EXISTS classes_institution_grade_section_unique;

-- Create new unique index that includes category
-- Using COALESCE(category, '') so that two NULL-category classes with same
-- grade+section still conflict (NULLs would otherwise be treated as distinct)
CREATE UNIQUE INDEX IF NOT EXISTS classes_institution_grade_section_category_unique
  ON classes (institution_id, grade_level, COALESCE(category, ''), section_name)
  WHERE grade_level IS NOT NULL AND section_name IS NOT NULL;

-- Trigger function to enforce one enrollment per category per student
-- A student can only be enrolled in one class per (institution_id, grade_level, category)
CREATE OR REPLACE FUNCTION enforce_one_enrollment_per_category()
RETURNS TRIGGER AS $$
DECLARE
  new_class RECORD;
  existing_enrollment RECORD;
BEGIN
  -- Only enforce for student role
  IF NEW.role <> 'student' THEN
    RETURN NEW;
  END IF;

  -- Look up the class being enrolled into
  SELECT institution_id, grade_level, category
  INTO new_class
  FROM classes
  WHERE id = NEW.class_id;

  -- Skip enforcement if the class has no grade_level (generic class)
  IF new_class.grade_level IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if the student already has an enrollment in another class
  -- with the same (institution_id, grade_level, category)
  SELECT ce.class_id
  INTO existing_enrollment
  FROM class_enrollments ce
  JOIN classes c ON c.id = ce.class_id
  WHERE ce.user_id = NEW.user_id
    AND ce.role = 'student'
    AND c.institution_id = new_class.institution_id
    AND c.grade_level = new_class.grade_level
    AND COALESCE(c.category, '') = COALESCE(new_class.category, '')
    AND ce.class_id <> NEW.class_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Student already enrolled in another section of the same grade and category'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger (covers INSERT and UPDATE of class_id to prevent bypassing
-- the one-enrollment-per-category constraint via direct row updates)
DROP TRIGGER IF EXISTS trg_enforce_one_enrollment_per_category ON class_enrollments;
CREATE TRIGGER trg_enforce_one_enrollment_per_category
  BEFORE INSERT OR UPDATE OF class_id ON class_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION enforce_one_enrollment_per_category();
