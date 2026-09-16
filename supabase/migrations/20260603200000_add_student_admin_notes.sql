-- Admin-managed student notes with audit trail (issue #519).
--
-- Adds:
--   * student_admin_notes: plain-text notes attached to a student, scoped to
--     an institution, written by admins/super-admins, readable also by
--     instructors who teach the student.
--   * student_admin_notes_audit: insert-only audit log written by trigger.
--   * RLS so the student themselves can never read or write.

-- ============================================================================
-- 1. student_admin_notes
-- ============================================================================

CREATE TABLE public.student_admin_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_student_admin_notes_student_institution_created
  ON public.student_admin_notes (student_user_id, institution_id, created_at DESC);
CREATE INDEX idx_student_admin_notes_institution_created
  ON public.student_admin_notes (institution_id, created_at DESC);

CREATE TRIGGER update_student_admin_notes_updated_at
  BEFORE UPDATE ON public.student_admin_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.student_admin_notes ENABLE ROW LEVEL SECURITY;

-- SELECT: admins / super-admins of the institution, OR instructors who teach
-- a class the student is enrolled in (scoped to the same institution so we
-- don't leak notes from one institution to instructors of another).
CREATE POLICY "Admins and teaching instructors can read student notes"
  ON public.student_admin_notes
  FOR SELECT
  USING (
    public.is_institution_admin(auth.uid(), institution_id)
    OR EXISTS (
      SELECT 1
      FROM public.class_enrollments ce
      JOIN public.classes cl ON cl.id = ce.class_id AND cl.is_active = true
      JOIN public.offerings o ON o.class_id = ce.class_id AND o.is_active = true
      JOIN public.course_instructors ci ON ci.course_id = o.course_id
      JOIN public.courses c ON c.id = o.course_id
      WHERE ce.user_id = student_admin_notes.student_user_id
        AND ce.role = 'student'
        AND ci.user_id = auth.uid()
        AND cl.institution_id = student_admin_notes.institution_id
        AND c.institution_id = student_admin_notes.institution_id
        AND public.instructor_can_access_section(o.course_id, o.class_id, auth.uid())
    )
  );

-- INSERT / UPDATE / DELETE: admins / super-admins of the institution only.
CREATE POLICY "Admins can insert student notes"
  ON public.student_admin_notes
  FOR INSERT
  WITH CHECK (public.is_institution_admin(auth.uid(), institution_id));

CREATE POLICY "Admins can update student notes"
  ON public.student_admin_notes
  FOR UPDATE
  USING (public.is_institution_admin(auth.uid(), institution_id))
  WITH CHECK (public.is_institution_admin(auth.uid(), institution_id));

CREATE POLICY "Admins can delete student notes"
  ON public.student_admin_notes
  FOR DELETE
  USING (public.is_institution_admin(auth.uid(), institution_id));

-- ============================================================================
-- 2. student_admin_notes_audit
-- ============================================================================

CREATE TABLE public.student_admin_notes_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  actor uuid,
  note_id uuid NOT NULL,
  student_user_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  prev_body text,
  new_body text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_student_admin_notes_audit_student
  ON public.student_admin_notes_audit (student_user_id, at DESC);
CREATE INDEX idx_student_admin_notes_audit_institution
  ON public.student_admin_notes_audit (institution_id, at DESC);

ALTER TABLE public.student_admin_notes_audit ENABLE ROW LEVEL SECURITY;

-- SELECT: admins / super-admins of the institution only. No INSERT/UPDATE/DELETE
-- policies, so all direct DML is rejected. Audit rows arrive solely through the
-- SECURITY DEFINER trigger below.
CREATE POLICY "Admins can read student notes audit"
  ON public.student_admin_notes_audit
  FOR SELECT
  USING (public.is_institution_admin(auth.uid(), institution_id));

-- ============================================================================
-- 3. Audit trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_student_admin_notes_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.student_admin_notes_audit
      (action, actor, note_id, student_user_id, institution_id, prev_body, new_body)
    VALUES
      ('insert', auth.uid(), NEW.id, NEW.student_user_id, NEW.institution_id, NULL, NEW.body);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.student_admin_notes_audit
      (action, actor, note_id, student_user_id, institution_id, prev_body, new_body)
    VALUES
      ('update', auth.uid(), NEW.id, NEW.student_user_id, NEW.institution_id, OLD.body, NEW.body);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.student_admin_notes_audit
      (action, actor, note_id, student_user_id, institution_id, prev_body, new_body)
    VALUES
      ('delete', auth.uid(), OLD.id, OLD.student_user_id, OLD.institution_id, OLD.body, NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER student_admin_notes_audit_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.student_admin_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.log_student_admin_notes_change();
