
-- Add back institution_id and role to profiles for backwards compatibility
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES public.institutions(id);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'student';
