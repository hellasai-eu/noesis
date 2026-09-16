-- Create junction table for open questions published to specific offerings (classes)
CREATE TABLE public.offering_open_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  open_question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  published_at TIMESTAMP WITH TIME ZONE, -- NULL = not published to this class
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (offering_id, open_question_id)
);

-- Create junction table for study sessions published to specific offerings (classes)
CREATE TABLE public.offering_study_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  study_session_id UUID NOT NULL REFERENCES public.study_sessions(id) ON DELETE CASCADE,
  published_at TIMESTAMP WITH TIME ZONE, -- NULL = not published to this class
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (offering_id, study_session_id)
);

-- Enable RLS on both tables
ALTER TABLE public.offering_open_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offering_study_sessions ENABLE ROW LEVEL SECURITY;

-- RLS policies for offering_open_questions

-- Managers (admins/instructors) can manage
CREATE POLICY "Managers can manage offering open questions"
ON public.offering_open_questions
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

-- Students can view published entries for their classes
CREATE POLICY "Students see published open questions"
ON public.offering_open_questions
FOR SELECT
USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- RLS policies for offering_study_sessions

-- Managers (admins/instructors) can manage
CREATE POLICY "Managers can manage offering study sessions"
ON public.offering_study_sessions
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

-- Students can view published entries for their classes
CREATE POLICY "Students see published study sessions"
ON public.offering_study_sessions
FOR SELECT
USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- Create triggers for updated_at
CREATE TRIGGER update_offering_open_questions_updated_at
BEFORE UPDATE ON public.offering_open_questions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_offering_study_sessions_updated_at
BEFORE UPDATE ON public.offering_study_sessions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();