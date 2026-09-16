-- Create class_tags junction table to allow tagging classes
CREATE TABLE public.class_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(class_id, tag_id)
);

-- Enable RLS
ALTER TABLE public.class_tags ENABLE ROW LEVEL SECURITY;

-- Admins can manage class tags
CREATE POLICY "Admins can manage class tags"
ON public.class_tags
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = class_tags.class_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR is_super_admin(auth.uid())
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = class_tags.class_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR is_super_admin(auth.uid())
);

-- Users can view class tags for classes in their institution
CREATE POLICY "Users can view class tags"
ON public.class_tags
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = class_tags.class_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);