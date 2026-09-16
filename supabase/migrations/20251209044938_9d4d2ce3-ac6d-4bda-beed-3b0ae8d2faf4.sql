-- Add instructions column to study_sessions for admin-provided teaching guidance
ALTER TABLE public.study_sessions 
ADD COLUMN instructions text;