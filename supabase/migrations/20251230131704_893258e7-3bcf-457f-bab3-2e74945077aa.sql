-- Create offering_questions junction table for assigning MCQ questions to offerings
CREATE TABLE public.offering_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  published_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(offering_id, question_id)
);

-- Enable RLS
ALTER TABLE public.offering_questions ENABLE ROW LEVEL SECURITY;

-- Managers can manage offering questions
CREATE POLICY "Managers can manage offering questions"
ON public.offering_questions
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

-- Students see published questions
CREATE POLICY "Students see published questions"
ON public.offering_questions
FOR SELECT
USING (has_offering_access(offering_id) AND published_at IS NOT NULL);

-- Create trigger for updated_at
CREATE TRIGGER update_offering_questions_updated_at
BEFORE UPDATE ON public.offering_questions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();