-- Add invited_class_id column to invitations table
-- This allows invitations to specify which class the student should be enrolled in upon acceptance

ALTER TABLE invitations ADD COLUMN invited_class_id UUID REFERENCES classes(id) ON DELETE SET NULL;

-- Add an index for efficient lookups
CREATE INDEX idx_invitations_invited_class_id ON invitations(invited_class_id) WHERE invited_class_id IS NOT NULL;

COMMENT ON COLUMN invitations.invited_class_id IS 'Optional class to auto-enroll the student in upon invitation acceptance';
