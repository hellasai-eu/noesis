-- Change default for allow_self_enrollment on classes to false
ALTER TABLE classes
ALTER COLUMN allow_self_enrollment SET DEFAULT false;
