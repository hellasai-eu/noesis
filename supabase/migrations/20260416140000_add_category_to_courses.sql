-- Add category column to courses table to track which section category the course was created for
ALTER TABLE courses ADD COLUMN category TEXT DEFAULT NULL;
