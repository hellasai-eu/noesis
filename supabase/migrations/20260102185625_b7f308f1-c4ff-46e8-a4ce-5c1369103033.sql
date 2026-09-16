-- Create table to cache evaluation timeline analysis
CREATE TABLE evaluation_timeline_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  
  -- The analysis data
  summary TEXT NOT NULL,
  overall_trend TEXT NOT NULL,
  competency_insights JSONB NOT NULL DEFAULT '[]',
  strengths TEXT[] NOT NULL DEFAULT '{}',
  areas_for_improvement TEXT[] NOT NULL DEFAULT '{}',
  recommendations TEXT[] NOT NULL DEFAULT '{}',
  
  -- Metadata
  evaluation_count INTEGER NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Unique constraint: one cached analysis per student per course
  UNIQUE(course_id, user_id)
);

-- Enable RLS
ALTER TABLE evaluation_timeline_cache ENABLE ROW LEVEL SECURITY;

-- Admins and instructors can manage timeline cache
CREATE POLICY "Admins and instructors can manage timeline cache"
ON evaluation_timeline_cache FOR ALL
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = evaluation_timeline_cache.course_id 
    AND ui.user_id = auth.uid() 
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
)
WITH CHECK (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = evaluation_timeline_cache.course_id 
    AND ui.user_id = auth.uid() 
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Create trigger for updated_at
CREATE TRIGGER update_evaluation_timeline_cache_updated_at
  BEFORE UPDATE ON evaluation_timeline_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();