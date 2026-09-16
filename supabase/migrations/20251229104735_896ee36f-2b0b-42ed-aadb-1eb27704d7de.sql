-- Create junction table for offering-chapter cheatsheet assignments
CREATE TABLE IF NOT EXISTS public.offering_chapter_cheatsheets (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  published_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(offering_id, chapter_id)
);

-- Enable RLS
ALTER TABLE public.offering_chapter_cheatsheets ENABLE ROW LEVEL SECURITY;

-- RLS Policies for offering_chapter_cheatsheets
CREATE POLICY "Managers can manage offering chapter cheatsheets"
ON public.offering_chapter_cheatsheets
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

CREATE POLICY "Students see published chapter cheatsheets"
ON public.offering_chapter_cheatsheets
FOR SELECT
USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_offering_chapter_cheatsheets_offering_id 
ON public.offering_chapter_cheatsheets(offering_id);

CREATE INDEX IF NOT EXISTS idx_offering_chapter_cheatsheets_chapter_id 
ON public.offering_chapter_cheatsheets(chapter_id);