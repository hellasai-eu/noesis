-- Migration: Remove dead tag-based access control infrastructure
--
-- Tags were originally used for access control but were fully replaced by
-- course_instructors + class enrollments + institution roles in migration
-- 20260403000000. The tag tables and functions are now dead code.
--
-- This migration:
-- 1. Renames user_has_course_tag_access() to user_can_access_course()
--    (PostgreSQL stores policy references by OID, so the rename is transparent)
-- 2. Drops unused tag functions
-- 3. Drops tag tables (in FK order)
-- 4. Drops the invited_tags column from invitations

BEGIN;

-- ============================================================
-- Part 1: Rename the access function
-- ============================================================
-- The function body is pure role-based (no tag logic since 20260403000000).
-- Rename to reflect its actual behavior.
ALTER FUNCTION public.user_has_course_tag_access(uuid, uuid)
  RENAME TO user_can_access_course;

-- ============================================================
-- Part 2: Drop unused tag helper functions
-- ============================================================
DROP FUNCTION IF EXISTS public.user_has_tag_access(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.user_has_all_course_tags(uuid, uuid) CASCADE;

-- ============================================================
-- Part 3: Drop RLS policies on tag tables (before dropping tables)
-- ============================================================
-- class_tags policies
DROP POLICY IF EXISTS "Admin manages class tags" ON public.class_tags;
DROP POLICY IF EXISTS "Users can view class tags in institution" ON public.class_tags;
DROP POLICY IF EXISTS "Admins can manage class tags" ON public.class_tags;
DROP POLICY IF EXISTS "Users can view class tags" ON public.class_tags;

-- course_tags policies
DROP POLICY IF EXISTS "Users can view course tags for accessible courses" ON public.course_tags;
DROP POLICY IF EXISTS "Admins can manage course tags" ON public.course_tags;
DROP POLICY IF EXISTS "Admins manage course tags" ON public.course_tags;
DROP POLICY IF EXISTS "Instructors can manage course tags" ON public.course_tags;

-- user_tags policies
DROP POLICY IF EXISTS "Users can view their own tags" ON public.user_tags;
DROP POLICY IF EXISTS "Admins can manage user tags" ON public.user_tags;
DROP POLICY IF EXISTS "Admins manage user tags" ON public.user_tags;

-- tags policies
DROP POLICY IF EXISTS "Users can view tags in institution" ON public.tags;
DROP POLICY IF EXISTS "Users can view institution tags" ON public.tags;
DROP POLICY IF EXISTS "Admins can manage tags" ON public.tags;
DROP POLICY IF EXISTS "Admins manage tags" ON public.tags;

-- ============================================================
-- Part 4: Drop tag tables (respecting FK order)
-- ============================================================
DROP TABLE IF EXISTS public.class_tags CASCADE;
DROP TABLE IF EXISTS public.course_tags CASCADE;
DROP TABLE IF EXISTS public.user_tags CASCADE;
DROP TABLE IF EXISTS public.tags CASCADE;

-- ============================================================
-- Part 5: Drop invited_tags column from invitations
-- ============================================================
ALTER TABLE public.invitations DROP COLUMN IF EXISTS invited_tags;

COMMIT;
