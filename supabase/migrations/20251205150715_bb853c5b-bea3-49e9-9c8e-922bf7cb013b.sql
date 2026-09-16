-- Create material_chapters table
CREATE TABLE public.material_chapters (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES public.course_materials(id) ON DELETE CASCADE,
  chapter_number integer NOT NULL,
  title text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('html_link', 'text', 'pdf', 'image')),
  content text, -- For text content or URLs
  file_url text, -- For uploaded PDFs/images
  file_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(material_id, chapter_number)
);

-- Enable RLS
ALTER TABLE public.material_chapters ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view chapters for accessible materials"
ON public.material_chapters
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Admins can insert chapters"
ON public.material_chapters
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

CREATE POLICY "Admins can update chapters"
ON public.material_chapters
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

CREATE POLICY "Admins can delete chapters"
ON public.material_chapters
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

-- Trigger for updated_at
CREATE TRIGGER update_material_chapters_updated_at
BEFORE UPDATE ON public.material_chapters
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();