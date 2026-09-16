-- Add unique constraint for course titles within an institution
ALTER TABLE public.courses
ADD CONSTRAINT courses_title_institution_unique UNIQUE (title, institution_id);

-- Add unique constraint for tag names within an institution
ALTER TABLE public.tags
ADD CONSTRAINT tags_name_institution_unique UNIQUE (name, institution_id);

-- Create function to auto-create tag for new course
CREATE OR REPLACE FUNCTION public.create_course_tag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tag_id uuid;
BEGIN
  -- Create a tag with the course name
  INSERT INTO public.tags (name, institution_id, color)
  VALUES (NEW.title, NEW.institution_id, '#6366f1')
  ON CONFLICT (name, institution_id) DO NOTHING
  RETURNING id INTO new_tag_id;
  
  -- If tag was created (not a conflict), link it to the course
  IF new_tag_id IS NOT NULL THEN
    INSERT INTO public.course_tags (course_id, tag_id)
    VALUES (NEW.id, new_tag_id);
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger to auto-create tag when course is created
CREATE TRIGGER create_course_tag_trigger
AFTER INSERT ON public.courses
FOR EACH ROW
EXECUTE FUNCTION public.create_course_tag();