-- Add admin_notifications table for in-app notifications to instructors/admins
-- when content moderation flags a student session.

CREATE TABLE public.admin_notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'content_moderation',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_notifications_course_id ON public.admin_notifications(course_id);
CREATE INDEX idx_admin_notifications_created_at ON public.admin_notifications(created_at DESC);

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

-- Course instructors can view notifications for their courses
CREATE POLICY "Course instructors can view notifications"
ON public.admin_notifications
FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR is_institution_admin(auth.uid(), (SELECT c.institution_id FROM courses c WHERE c.id = admin_notifications.course_id))
  OR is_course_instructor(course_id, auth.uid())
);

-- Course instructors can mark notifications as read
CREATE POLICY "Course instructors can update notifications"
ON public.admin_notifications
FOR UPDATE
USING (
  is_super_admin(auth.uid())
  OR is_institution_admin(auth.uid(), (SELECT c.institution_id FROM courses c WHERE c.id = admin_notifications.course_id))
  OR is_course_instructor(course_id, auth.uid())
)
WITH CHECK (
  is_super_admin(auth.uid())
  OR is_institution_admin(auth.uid(), (SELECT c.institution_id FROM courses c WHERE c.id = admin_notifications.course_id))
  OR is_course_instructor(course_id, auth.uid())
);
