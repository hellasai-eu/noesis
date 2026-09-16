-- Add is_visible column to flashcard_sessions for course-level visibility
ALTER TABLE public.flashcard_sessions 
ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true;

-- Create junction table for offering-flashcard session assignments
CREATE TABLE IF NOT EXISTS public.offering_flashcard_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  flashcard_session_id uuid NOT NULL REFERENCES public.flashcard_sessions(id) ON DELETE CASCADE,
  published_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(offering_id, flashcard_session_id)
);

-- Enable RLS
ALTER TABLE public.offering_flashcard_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for offering_flashcard_sessions
CREATE POLICY "Managers can manage offering flashcard sessions"
ON public.offering_flashcard_sessions
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

CREATE POLICY "Students see published flashcard sessions"
ON public.offering_flashcard_sessions
FOR SELECT
USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_offering_flashcard_sessions_offering_id 
ON public.offering_flashcard_sessions(offering_id);

CREATE INDEX IF NOT EXISTS idx_offering_flashcard_sessions_flashcard_session_id 
ON public.offering_flashcard_sessions(flashcard_session_id);