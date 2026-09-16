-- Add role column to invitations table
ALTER TABLE public.invitations 
ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'student';

-- Add check constraint for valid roles
ALTER TABLE public.invitations 
ADD CONSTRAINT invitations_role_check 
CHECK (role IN ('admin', 'instructor', 'student'));