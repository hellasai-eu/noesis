-- Add leaderboard_enabled column to courses
ALTER TABLE public.courses 
ADD COLUMN leaderboard_enabled boolean NOT NULL DEFAULT false;