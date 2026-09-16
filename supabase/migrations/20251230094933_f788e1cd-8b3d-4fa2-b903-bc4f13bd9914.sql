-- Create offering_chapter_flashcards table for assigning chapter flashcards to offerings
CREATE TABLE public.offering_chapter_flashcards (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  published_at TIMESTAMP WITH TIME ZONE NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(offering_id, chapter_id)
);

-- Enable RLS
ALTER TABLE public.offering_chapter_flashcards ENABLE ROW LEVEL SECURITY;

-- Managers can manage offering chapter flashcards
CREATE POLICY "Managers can manage offering chapter flashcards"
ON public.offering_chapter_flashcards
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

-- Students see published chapter flashcards
CREATE POLICY "Students see published chapter flashcards"
ON public.offering_chapter_flashcards
FOR SELECT
USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- Add trigger for updated_at
CREATE TRIGGER update_offering_chapter_flashcards_updated_at
BEFORE UPDATE ON public.offering_chapter_flashcards
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();