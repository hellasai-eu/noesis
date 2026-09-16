-- Create prompt_examples table to store example content and OpenAI file references
CREATE TABLE public.prompt_examples (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  prompt_key TEXT NOT NULL,
  institution_id UUID REFERENCES public.institutions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  openai_file_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.prompt_examples ENABLE ROW LEVEL SECURITY;

-- Super admins can manage prompt examples
CREATE POLICY "Super admins can view prompt examples"
ON public.prompt_examples
FOR SELECT
USING (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can insert prompt examples"
ON public.prompt_examples
FOR INSERT
WITH CHECK (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can update prompt examples"
ON public.prompt_examples
FOR UPDATE
USING (is_super_admin(auth.uid()));

CREATE POLICY "Super admins can delete prompt examples"
ON public.prompt_examples
FOR DELETE
USING (is_super_admin(auth.uid()));

-- Add trigger for updated_at
CREATE TRIGGER update_prompt_examples_updated_at
BEFORE UPDATE ON public.prompt_examples
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();