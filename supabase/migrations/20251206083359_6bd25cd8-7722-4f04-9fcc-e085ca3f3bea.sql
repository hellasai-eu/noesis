-- Add invited_name and invited_tags columns to invitations table
ALTER TABLE public.invitations 
ADD COLUMN invited_name text,
ADD COLUMN invited_tags jsonb DEFAULT '[]'::jsonb;