-- Drop the trigger that auto-creates tags with course names
DROP TRIGGER IF EXISTS on_course_created ON public.courses;

-- Drop the function as well since it's no longer needed
DROP FUNCTION IF EXISTS public.create_course_tag();