-- Add metadata columns to course_materials
ALTER TABLE public.course_materials
ADD COLUMN title TEXT,
ADD COLUMN author TEXT,
ADD COLUMN year INTEGER,
ADD COLUMN description TEXT;