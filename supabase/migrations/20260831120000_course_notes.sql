-- Migration: instructor-distributed course notes (PDF / DOC / TXT).
--
-- Instructors upload a document against a course and target it at one or more
-- sections (offerings); targeted students see it on their course home and can
-- download it. The shape deliberately mirrors class_announcements:
--   * the note belongs to the COURSE,
--   * targeting lives in a junction table,
--   * a note with zero targets is a draft — invisible to students.
--
-- The bytes live in a private 'course-notes' storage bucket keyed
-- "<course_id>/<uuid>-<sanitised name>"; storage.objects policies re-derive the
-- same permission from that key (INSERT, before any row exists) or from the
-- course_notes row that owns it (SELECT/DELETE).

-- ============================================================
-- 1. Tables
-- ============================================================
CREATE TABLE IF NOT EXISTS public.course_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 5000),
  -- Storage key inside the 'course-notes' bucket. Unique so two rows can never
  -- claim the same object and disagree about who may read it.
  file_path text NOT NULL UNIQUE CHECK (char_length(file_path) BETWEEN 1 AND 1024),
  file_name text NOT NULL CHECK (
    file_name ~* '\.(pdf|doc|docx|odt|rtf|txt|md)$'
  ),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 255),
  -- 25 MiB, the same ceiling the bucket enforces.
  file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 26214400),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_course_notes_course_created
  ON public.course_notes (course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.course_note_offerings (
  note_id uuid NOT NULL REFERENCES public.course_notes(id) ON DELETE CASCADE,
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, offering_id)
);

CREATE INDEX IF NOT EXISTS idx_course_note_offerings_offering
  ON public.course_note_offerings (offering_id);

CREATE TRIGGER update_course_notes_updated_at
  BEFORE UPDATE ON public.course_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 2. Permission helpers
--
-- SECURITY DEFINER so the storage.objects policies can reuse them without
-- re-entering course_notes' own RLS.
-- ============================================================

-- A manager of a course is anyone who can manage at least one of its offerings.
-- A course with no offerings therefore has no note managers — the same
-- limitation announcements have, and the instructor UI says so.
CREATE OR REPLACE FUNCTION public.can_manage_course_notes(_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM offerings o
    WHERE o.course_id = _course_id
      AND can_manage_offering(o.id)
  )
$$;

-- A student may read a note only through a targeted offering they belong to.
CREATE OR REPLACE FUNCTION public.can_read_course_note(_note_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM course_notes n
    JOIN course_note_offerings cno ON cno.note_id = n.id
    JOIN offerings o ON o.id = cno.offering_id
    WHERE n.id = _note_id
      AND o.course_id = n.course_id
      AND has_offering_access(o.id)
  )
$$;

-- Storage-side counterpart, keyed by the object path rather than the note id.
CREATE OR REPLACE FUNCTION public.can_read_course_note_file(_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM course_notes n
    WHERE n.file_path = _path
      AND (can_manage_course_notes(n.course_id) OR can_read_course_note(n.id))
  )
$$;

-- The first path segment of a 'course-notes' object is the course uuid. Guard
-- the cast: an object uploaded under a non-uuid prefix must fail closed, not
-- raise 22P02 and abort the whole statement.
CREATE OR REPLACE FUNCTION public.course_notes_path_course_id(_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN split_part(_name, '/', 1) ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(_name, '/', 1)::uuid
  END
$$;

-- ============================================================
-- 3. RLS
-- ============================================================
ALTER TABLE public.course_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_note_offerings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers manage course notes"
  ON public.course_notes
  FOR ALL
  USING (public.can_manage_course_notes(course_id))
  WITH CHECK (public.can_manage_course_notes(course_id));

CREATE POLICY "Targeted members read course notes"
  ON public.course_notes
  FOR SELECT
  USING (public.can_read_course_note(id));

CREATE POLICY "Managers manage course note targets"
  ON public.course_note_offerings
  FOR ALL
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

CREATE POLICY "Offering members read course note targets"
  ON public.course_note_offerings
  FOR SELECT
  USING (public.has_offering_access(offering_id));

-- ============================================================
-- 4. Storage bucket + policies
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('course-notes', 'course-notes', false, 26214400)
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit;

-- Upload happens before the course_notes row exists, so the only thing to
-- authorise against is the course id encoded in the key.
CREATE POLICY "Course managers upload notes"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'course-notes'
    AND public.course_notes_path_course_id(name) IS NOT NULL
    AND public.can_manage_course_notes(public.course_notes_path_course_id(name))
  );

-- Read: managers of the owning course, plus students of a targeted section.
-- The prefix arm also covers the window between upload and row insert, and an
-- orphan left behind by a failed insert.
CREATE POLICY "Course notes are readable by managers and targeted students"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'course-notes'
    AND (
      public.can_read_course_note_file(name)
      OR (
        public.course_notes_path_course_id(name) IS NOT NULL
        AND public.can_manage_course_notes(public.course_notes_path_course_id(name))
      )
    )
  );

CREATE POLICY "Course managers delete notes"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'course-notes'
    AND public.course_notes_path_course_id(name) IS NOT NULL
    AND public.can_manage_course_notes(public.course_notes_path_course_id(name))
  );
