-- Drop institution_id and role columns from profiles table if they exist
ALTER TABLE public.profiles DROP COLUMN IF EXISTS institution_id;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS role;