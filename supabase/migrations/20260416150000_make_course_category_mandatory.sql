-- Make category mandatory on courses, defaulting to 'Default'
-- Existing NULL-category courses are treated as Default
UPDATE courses SET category = 'Default' WHERE category IS NULL;

ALTER TABLE courses ALTER COLUMN category SET DEFAULT 'Default';
ALTER TABLE courses ALTER COLUMN category SET NOT NULL;
