-- Create graded_tests table for storing test uploads and overall grading data
CREATE TABLE public.graded_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  student_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  student_name text,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ocr_complete', 'grading', 'graded', 'error')),
  
  -- Original upload
  original_file_url text NOT NULL,
  original_file_name text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('pdf', 'image')),
  
  -- OCR results
  ocr_text text,
  ocr_pages jsonb DEFAULT '[]'::jsonb, -- Array of {page_number, text, image_url}
  
  -- Grading configuration
  grading_criteria text, -- Instructor-defined criteria/rubric
  answer_key text, -- Model answers or sketches
  total_points numeric,
  
  -- Results
  total_score numeric,
  graded_pdf_url text,
  feedback text,
  
  -- Metadata
  graded_by uuid REFERENCES auth.users(id),
  graded_at timestamp with time zone,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create graded_test_questions for individual question grading
CREATE TABLE public.graded_test_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graded_test_id uuid NOT NULL REFERENCES public.graded_tests(id) ON DELETE CASCADE,
  question_number integer NOT NULL,
  question_text text, -- Extracted from OCR
  student_answer text, -- Student's OCR'd answer
  expected_answer text, -- Model answer for this question
  max_points numeric NOT NULL DEFAULT 0,
  awarded_points numeric,
  ai_feedback text,
  instructor_feedback text,
  page_number integer,
  bounding_box jsonb, -- For annotation positioning
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.graded_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graded_test_questions ENABLE ROW LEVEL SECURITY;

-- RLS policies for graded_tests
CREATE POLICY "Admins and instructors can manage graded tests"
ON public.graded_tests FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = graded_tests.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Students can view their own graded tests"
ON public.graded_tests FOR SELECT
USING (student_id = auth.uid());

-- RLS policies for graded_test_questions
CREATE POLICY "Admins and instructors can manage test questions"
ON public.graded_test_questions FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM graded_tests gt
    JOIN courses c ON gt.course_id = c.id
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE gt.id = graded_test_questions.graded_test_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Students can view their own test questions"
ON public.graded_test_questions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM graded_tests gt
    WHERE gt.id = graded_test_questions.graded_test_id
    AND gt.student_id = auth.uid()
  )
);

-- Create indexes for performance
CREATE INDEX idx_graded_tests_course_id ON public.graded_tests(course_id);
CREATE INDEX idx_graded_tests_student_id ON public.graded_tests(student_id);
CREATE INDEX idx_graded_tests_status ON public.graded_tests(status);
CREATE INDEX idx_graded_test_questions_test_id ON public.graded_test_questions(graded_test_id);

-- Trigger for updated_at
CREATE TRIGGER update_graded_tests_updated_at
BEFORE UPDATE ON public.graded_tests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_graded_test_questions_updated_at
BEFORE UPDATE ON public.graded_test_questions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create storage bucket for graded tests
INSERT INTO storage.buckets (id, name, public)
VALUES ('graded-tests', 'graded-tests', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for graded-tests bucket
CREATE POLICY "Admins and instructors can upload test files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'graded-tests' AND
  (is_super_admin(auth.uid()) OR
   EXISTS (
     SELECT 1 FROM user_institutions ui
     WHERE ui.user_id = auth.uid()
     AND (ui.role = 'admin' OR ui.role = 'instructor')
   ))
);

CREATE POLICY "Admins and instructors can view test files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'graded-tests' AND
  (is_super_admin(auth.uid()) OR
   EXISTS (
     SELECT 1 FROM user_institutions ui
     WHERE ui.user_id = auth.uid()
     AND (ui.role = 'admin' OR ui.role = 'instructor')
   ))
);

CREATE POLICY "Admins and instructors can delete test files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'graded-tests' AND
  (is_super_admin(auth.uid()) OR
   EXISTS (
     SELECT 1 FROM user_institutions ui
     WHERE ui.user_id = auth.uid()
     AND (ui.role = 'admin' OR ui.role = 'instructor')
   ))
);