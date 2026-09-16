
-- First drop ALL policies that depend on profiles.institution_id or profiles.role
DROP POLICY IF EXISTS "Admins can update their institution" ON public.institutions;
DROP POLICY IF EXISTS "Admins can create courses" ON public.courses;
DROP POLICY IF EXISTS "Admins can update courses" ON public.courses;
DROP POLICY IF EXISTS "Admins can delete courses" ON public.courses;
DROP POLICY IF EXISTS "Admins and instructors can insert course materials" ON public.course_materials;
DROP POLICY IF EXISTS "Admins and instructors can update course materials" ON public.course_materials;
DROP POLICY IF EXISTS "Admins and instructors can delete course materials" ON public.course_materials;
DROP POLICY IF EXISTS "Users can view chapters for accessible materials" ON public.material_chapters;
DROP POLICY IF EXISTS "Admins and instructors can insert chapters" ON public.material_chapters;
DROP POLICY IF EXISTS "Admins and instructors can update chapters" ON public.material_chapters;
DROP POLICY IF EXISTS "Admins and instructors can delete chapters" ON public.material_chapters;
DROP POLICY IF EXISTS "Admins can create invitations" ON public.invitations;
DROP POLICY IF EXISTS "Admins can update invitations" ON public.invitations;
DROP POLICY IF EXISTS "Admins can delete invitations" ON public.invitations;
DROP POLICY IF EXISTS "Admins and instructors can create questions" ON public.questions;
DROP POLICY IF EXISTS "Admins and instructors can update questions" ON public.questions;
DROP POLICY IF EXISTS "Admins and instructors can delete questions" ON public.questions;
DROP POLICY IF EXISTS "Admins and instructors can create quizzes" ON public.quizzes;
DROP POLICY IF EXISTS "Admins and instructors can update quizzes" ON public.quizzes;
DROP POLICY IF EXISTS "Admins and instructors can delete quizzes" ON public.quizzes;
DROP POLICY IF EXISTS "Admins and instructors can manage quiz questions" ON public.quiz_questions;
DROP POLICY IF EXISTS "Admins can view all quiz answers" ON public.quiz_answers;
DROP POLICY IF EXISTS "Admins can delete quiz answers" ON public.quiz_answers;
DROP POLICY IF EXISTS "Users can view materials in their courses" ON public.course_materials;
DROP POLICY IF EXISTS "Users can view invitations" ON public.invitations;
DROP POLICY IF EXISTS "Users can view questions for accessible courses" ON public.questions;
DROP POLICY IF EXISTS "Users can view quizzes for accessible courses" ON public.quizzes;
DROP POLICY IF EXISTS "Users can view quiz questions for accessible quizzes" ON public.quiz_questions;
DROP POLICY IF EXISTS "Admins can view all profiles in their institution" ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all votes" ON public.question_votes;
DROP POLICY IF EXISTS "Users can view tags in their institution" ON public.tags;
DROP POLICY IF EXISTS "Admins can create tags" ON public.tags;
DROP POLICY IF EXISTS "Admins can update tags" ON public.tags;
DROP POLICY IF EXISTS "Admins can delete tags" ON public.tags;
DROP POLICY IF EXISTS "Admins can view user tags in their institution" ON public.user_tags;
DROP POLICY IF EXISTS "Admins can assign user tags" ON public.user_tags;
DROP POLICY IF EXISTS "Admins can remove user tags" ON public.user_tags;

-- Now remove institution_id and role from profiles table
ALTER TABLE public.profiles DROP COLUMN IF EXISTS institution_id;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS role;
