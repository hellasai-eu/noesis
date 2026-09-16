-- Add grade_level column to user_institutions for student grade filtering
ALTER TABLE user_institutions ADD COLUMN grade_level TEXT;

-- CHECK constraint: must be a valid grade level value (or NULL)
ALTER TABLE user_institutions ADD CONSTRAINT user_institutions_grade_level_check
  CHECK (grade_level IN (
    'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
    'gymnasio_1','gymnasio_2','gymnasio_3',
    'lykeio_1','lykeio_2','lykeio_3'
  ));

-- Index for efficient filtering of students by grade level within an institution
CREATE INDEX idx_user_institutions_grade
  ON user_institutions (institution_id, role, grade_level)
  WHERE role = 'student';

-- Add invited_grade_level to invitations so grade level is carried through the invite flow
ALTER TABLE invitations ADD COLUMN invited_grade_level TEXT;

ALTER TABLE invitations ADD CONSTRAINT invitations_invited_grade_level_check
  CHECK (invited_grade_level IN (
    'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
    'gymnasio_1','gymnasio_2','gymnasio_3',
    'lykeio_1','lykeio_2','lykeio_3'
  ));
