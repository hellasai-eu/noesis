-- Add validation columns to questions table
ALTER TABLE public.questions
ADD COLUMN validation_status TEXT DEFAULT NULL,
ADD COLUMN validation_confidence NUMERIC DEFAULT NULL,
ADD COLUMN validation_message TEXT DEFAULT NULL,
ADD COLUMN validated_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.questions.validation_status IS 'AI validation verdict: CORRECT, PARTIALLY_CORRECT, INCORRECT, or INSUFFICIENT_INFORMATION';
COMMENT ON COLUMN public.questions.validation_confidence IS 'Confidence score (0-1) from the AI validator';
COMMENT ON COLUMN public.questions.validation_message IS 'Explanation message from the AI validator';
COMMENT ON COLUMN public.questions.validated_at IS 'Timestamp of when the question was last validated';