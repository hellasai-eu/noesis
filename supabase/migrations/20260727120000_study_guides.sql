-- Study Guides (#977, part of epic #976)
--
-- A study guide is an ordered sequence of self-contained *pieces*. Each piece
-- pairs explanatory theory (HTML + MathML, same convention as cheat sheets)
-- with follow-up questions drawn from the unified `public.questions` table.
--
-- Assignment follows the established `offering_<artifact>` pattern:
--   (offering_id, content_id, nullable group_id, published_at)
-- where `published_at IS NOT NULL` is the "assigned" predicate, `group_id IS
-- NULL` means whole section, a manual group means a sub-group, and an
-- `is_individual` group means exactly one student. See
-- 20251229104735 (original cheatsheet junction), 20260603100000 (group_id
-- across all seven junctions) and 20260603100001 (composite FK integrity).
--
-- Provenance note: study-guide questions live in the shared `public.questions`
-- table. `study_guide_piece_questions` is the SOLE marker distinguishing them
-- from Question Bank rows — no `source`/`origin` column is added to
-- `questions`. Modelled on `question_chapters` (20260425000000).

-- ============================================================================
-- 1. Guide + its source scoping
-- ============================================================================

CREATE TABLE public.study_guides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  material_id UUID REFERENCES public.course_materials(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  -- The instructor's free-text description of what the guide should cover.
  brief TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  -- Generation hints. The model treats these as strong hints, not hard limits.
  target_piece_count INTEGER NOT NULL DEFAULT 5,
  target_questions_per_piece INTEGER NOT NULL DEFAULT 5,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT study_guides_status_check
    CHECK (status IN ('draft', 'generating', 'ready', 'failed')),
  CONSTRAINT study_guides_target_piece_count_check
    CHECK (target_piece_count BETWEEN 1 AND 20),
  CONSTRAINT study_guides_target_questions_per_piece_check
    CHECK (target_questions_per_piece BETWEEN 1 AND 20)
);

CREATE INDEX idx_study_guides_course ON public.study_guides(course_id);
CREATE INDEX idx_study_guides_material ON public.study_guides(material_id);

-- Which chapters of the material feed this guide. Absent rows = whole material.
CREATE TABLE public.study_guide_source_chapters (
  study_guide_id UUID NOT NULL REFERENCES public.study_guides(id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL REFERENCES public.material_chapters(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (study_guide_id, chapter_id)
);

CREATE INDEX idx_study_guide_source_chapters_chapter
  ON public.study_guide_source_chapters(chapter_id);

-- ============================================================================
-- 2. Pieces + their questions
-- ============================================================================

CREATE TABLE public.study_guide_pieces (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  study_guide_id UUID NOT NULL REFERENCES public.study_guides(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  -- HTML with MathML for formulae, per MATHML_FORMATTING_INSTRUCTIONS.
  theory_html TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT study_guide_pieces_position_check CHECK (position >= 0),
  CONSTRAINT study_guide_pieces_guide_position_key UNIQUE (study_guide_id, position)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX idx_study_guide_pieces_guide ON public.study_guide_pieces(study_guide_id);

CREATE TABLE public.study_guide_piece_questions (
  piece_id UUID NOT NULL REFERENCES public.study_guide_pieces(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (piece_id, question_id),
  CONSTRAINT study_guide_piece_questions_position_check CHECK (position >= 0)
);

-- Drives the Question Bank exclusion lookup (`question_id IN (...)`).
CREATE INDEX idx_study_guide_piece_questions_question
  ON public.study_guide_piece_questions(question_id);

-- ============================================================================
-- 3. Assignment junction
-- ============================================================================

CREATE TABLE public.offering_study_guides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  study_guide_id UUID NOT NULL REFERENCES public.study_guides(id) ON DELETE CASCADE,
  group_id UUID,
  published_at TIMESTAMP WITH TIME ZONE, -- NULL = not published to this target
  -- Advisory only: passing it does not lock the guide (no `closed_at` in v1).
  due_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT offering_study_guides_offering_guide_group_key
    UNIQUE NULLS NOT DISTINCT (offering_id, study_guide_id, group_id),
  -- Composite FK so a group can never be attached to the wrong offering
  -- (mirrors 20260603100001_offering_group_cross_offering_integrity.sql).
  CONSTRAINT offering_study_guides_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_offering_study_guides_offering ON public.offering_study_guides(offering_id);
CREATE INDEX idx_offering_study_guides_guide ON public.offering_study_guides(study_guide_id);
CREATE INDEX idx_offering_study_guides_group ON public.offering_study_guides(group_id);

-- ============================================================================
-- 4. Student progress + answers
-- ============================================================================

CREATE TABLE public.study_guide_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  study_guide_id UUID NOT NULL REFERENCES public.study_guides(id) ON DELETE CASCADE,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  -- Position of the furthest piece the student may open. Advances on submit.
  current_piece_position INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT study_guide_progress_position_check CHECK (current_piece_position >= 0),
  CONSTRAINT study_guide_progress_user_guide_offering_key
    UNIQUE (user_id, study_guide_id, offering_id)
);

CREATE INDEX idx_study_guide_progress_guide_offering
  ON public.study_guide_progress(study_guide_id, offering_id);

-- Answers are study-guide-owned rather than reusing `open_question_grades`:
-- they need offering + piece scoping, and a guide attempt must not collide
-- with or pollute practice progress on the same question.
CREATE TABLE public.study_guide_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  study_guide_id UUID NOT NULL REFERENCES public.study_guides(id) ON DELETE CASCADE,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  piece_id UUID NOT NULL REFERENCES public.study_guide_pieces(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  -- Raw student response; shape varies by question type (see question-payload.ts).
  submission JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_correct BOOLEAN,
  grade NUMERIC,
  feedback TEXT,
  strengths TEXT[],
  areas_for_improvement TEXT[],
  graded_at TIMESTAMP WITH TIME ZONE,
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  -- One answer per student per question per offering: answers are immutable
  -- once submitted (no retakes in v1).
  CONSTRAINT study_guide_answers_user_offering_question_key
    UNIQUE (user_id, offering_id, question_id)
);

CREATE INDEX idx_study_guide_answers_guide_offering
  ON public.study_guide_answers(study_guide_id, offering_id);
CREATE INDEX idx_study_guide_answers_piece ON public.study_guide_answers(piece_id);
CREATE INDEX idx_study_guide_answers_user ON public.study_guide_answers(user_id);

-- ============================================================================
-- 5. updated_at triggers
-- ============================================================================

CREATE TRIGGER update_study_guides_updated_at
  BEFORE UPDATE ON public.study_guides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_study_guide_pieces_updated_at
  BEFORE UPDATE ON public.study_guide_pieces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_offering_study_guides_updated_at
  BEFORE UPDATE ON public.offering_study_guides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_study_guide_progress_updated_at
  BEFORE UPDATE ON public.study_guide_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 6. Helper: is a guide published to the calling student?
--    Used by the student-side SELECT policies on the content tables so a
--    student can read the pieces/questions of a guide assigned to them.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.study_guide_published_to_user(_study_guide_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.offering_study_guides osg
    WHERE osg.study_guide_id = _study_guide_id
      AND osg.published_at IS NOT NULL
      AND public.has_offering_access(osg.offering_id)
      AND (osg.group_id IS NULL OR public.is_offering_group_member(osg.group_id))
  )
$$;

-- Offering-scoped variant. `study_guide_published_to_user` answers "may this
-- user see this guide at all", which is the right question for reading guide
-- content but too loose for writing progress/answers: those rows carry an
-- independent `offering_id`, so a student assigned the guide through offering
-- A could otherwise file progress against offering B and appear in the results
-- of a class the guide was never assigned to.
CREATE OR REPLACE FUNCTION public.study_guide_assigned_in_offering(
  _study_guide_id UUID,
  _offering_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.offering_study_guides osg
    WHERE osg.study_guide_id = _study_guide_id
      AND osg.offering_id = _offering_id
      AND osg.published_at IS NOT NULL
      AND public.has_offering_access(osg.offering_id)
      AND (osg.group_id IS NULL OR public.is_offering_group_member(osg.group_id))
  )
$$;

-- ============================================================================
-- 6b. Cross-course integrity
--
-- `offering_id` and `study_guide_id` are independent FKs, so nothing stops a
-- manager of offering X from publishing a guide belonging to course Y —
-- handing that offering's students content from a course they are not taking.
-- The offering's course and the guide's course must agree. Enforced by trigger
-- rather than a composite FK so the generic assignment writer in
-- `useContentAssignments` can keep inserting (offering_id, content_id,
-- group_id, published_at) without a denormalized course_id column.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.offering_study_guides_course_must_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.offerings o
    JOIN public.study_guides sg ON sg.id = NEW.study_guide_id
    WHERE o.id = NEW.offering_id
      AND o.course_id = sg.course_id
  ) THEN
    RAISE EXCEPTION
      'study guide % does not belong to the course of offering %',
      NEW.study_guide_id, NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_offering_study_guides_course_must_match
  BEFORE INSERT OR UPDATE OF offering_id, study_guide_id
  ON public.offering_study_guides
  FOR EACH ROW EXECUTE FUNCTION public.offering_study_guides_course_must_match();

-- Same class of mismatch on the answer rows. `study_guide_id`, `piece_id` and
-- `question_id` are independent FKs, so without this an answer could name a
-- piece from a different guide, or a question that is not in the named piece —
-- misattributing the answer and burning the (user, offering, question)
-- uniqueness slot a legitimate submission needs.
CREATE OR REPLACE FUNCTION public.study_guide_answers_tuple_must_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.study_guide_pieces p
    WHERE p.id = NEW.piece_id
      AND p.study_guide_id = NEW.study_guide_id
  ) THEN
    RAISE EXCEPTION
      'piece % does not belong to study guide %',
      NEW.piece_id, NEW.study_guide_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.study_guide_piece_questions pq
    WHERE pq.piece_id = NEW.piece_id
      AND pq.question_id = NEW.question_id
  ) THEN
    RAISE EXCEPTION
      'question % is not part of piece %',
      NEW.question_id, NEW.piece_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_study_guide_answers_tuple_must_match
  BEFORE INSERT OR UPDATE OF piece_id, study_guide_id, question_id
  ON public.study_guide_answers
  FOR EACH ROW EXECUTE FUNCTION public.study_guide_answers_tuple_must_match();

-- ============================================================================
-- 7. RLS
-- ============================================================================

ALTER TABLE public.study_guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_guide_source_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_guide_pieces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_guide_piece_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offering_study_guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_guide_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_guide_answers ENABLE ROW LEVEL SECURITY;

-- ---- study_guides -----------------------------------------------------------

CREATE POLICY "Managers can manage study guides"
  ON public.study_guides
  FOR ALL
  USING (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = study_guides.course_id)
       )
    OR public.is_course_instructor(course_id, auth.uid())
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = study_guides.course_id)
       )
    OR public.is_course_instructor(course_id, auth.uid())
  );

CREATE POLICY "Students see study guides published to them"
  ON public.study_guides
  FOR SELECT
  USING (public.study_guide_published_to_user(id));

-- ---- study_guide_source_chapters -------------------------------------------
-- Instructor-only: which chapters fed generation is authoring metadata.

CREATE POLICY "Managers can manage study guide source chapters"
  ON public.study_guide_source_chapters
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.study_guides sg
      WHERE sg.id = study_guide_source_chapters.study_guide_id
        AND (
          public.is_super_admin(auth.uid())
          OR public.is_institution_admin(
               auth.uid(),
               (SELECT c.institution_id FROM public.courses c WHERE c.id = sg.course_id)
             )
          OR public.is_course_instructor(sg.course_id, auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.study_guides sg
      WHERE sg.id = study_guide_source_chapters.study_guide_id
        AND (
          public.is_super_admin(auth.uid())
          OR public.is_institution_admin(
               auth.uid(),
               (SELECT c.institution_id FROM public.courses c WHERE c.id = sg.course_id)
             )
          OR public.is_course_instructor(sg.course_id, auth.uid())
        )
    )
  );

-- ---- study_guide_pieces -----------------------------------------------------

CREATE POLICY "Managers can manage study guide pieces"
  ON public.study_guide_pieces
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.study_guides sg
      WHERE sg.id = study_guide_pieces.study_guide_id
        AND (
          public.is_super_admin(auth.uid())
          OR public.is_institution_admin(
               auth.uid(),
               (SELECT c.institution_id FROM public.courses c WHERE c.id = sg.course_id)
             )
          OR public.is_course_instructor(sg.course_id, auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.study_guides sg
      WHERE sg.id = study_guide_pieces.study_guide_id
        AND (
          public.is_super_admin(auth.uid())
          OR public.is_institution_admin(
               auth.uid(),
               (SELECT c.institution_id FROM public.courses c WHERE c.id = sg.course_id)
             )
          OR public.is_course_instructor(sg.course_id, auth.uid())
        )
    )
  );

-- Students see every piece of a guide published to them. Sequential gating is
-- enforced in the player, not by RLS — locking piece N+1 at the database level
-- would require a progress subquery on every read for no security benefit
-- (the content is assigned to them either way).
CREATE POLICY "Students see pieces of published study guides"
  ON public.study_guide_pieces
  FOR SELECT
  USING (public.study_guide_published_to_user(study_guide_id));

-- ---- study_guide_piece_questions -------------------------------------------

CREATE POLICY "Managers can manage study guide piece questions"
  ON public.study_guide_piece_questions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.study_guide_pieces p
      JOIN public.study_guides sg ON sg.id = p.study_guide_id
      WHERE p.id = study_guide_piece_questions.piece_id
        AND (
          public.is_super_admin(auth.uid())
          OR public.is_institution_admin(
               auth.uid(),
               (SELECT c.institution_id FROM public.courses c WHERE c.id = sg.course_id)
             )
          OR public.is_course_instructor(sg.course_id, auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.study_guide_pieces p
      JOIN public.study_guides sg ON sg.id = p.study_guide_id
      WHERE p.id = study_guide_piece_questions.piece_id
        AND (
          public.is_super_admin(auth.uid())
          OR public.is_institution_admin(
               auth.uid(),
               (SELECT c.institution_id FROM public.courses c WHERE c.id = sg.course_id)
             )
          OR public.is_course_instructor(sg.course_id, auth.uid())
        )
    )
  );

CREATE POLICY "Students see piece questions of published study guides"
  ON public.study_guide_piece_questions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.study_guide_pieces p
      WHERE p.id = study_guide_piece_questions.piece_id
        AND public.study_guide_published_to_user(p.study_guide_id)
    )
  );

-- ---- offering_study_guides --------------------------------------------------

CREATE POLICY "Managers can manage offering study guides"
  ON public.offering_study_guides
  FOR ALL
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

CREATE POLICY "Students see published study guides"
  ON public.offering_study_guides
  FOR SELECT
  USING (
    published_at IS NOT NULL
    AND public.has_offering_access(offering_id)
    AND (group_id IS NULL OR public.is_offering_group_member(group_id))
  );

-- ---- study_guide_progress ---------------------------------------------------

CREATE POLICY "Managers can view study guide progress"
  ON public.study_guide_progress
  FOR SELECT
  USING (public.can_manage_offering(offering_id));

CREATE POLICY "Students manage their own study guide progress"
  ON public.study_guide_progress
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND public.study_guide_assigned_in_offering(study_guide_id, offering_id)
  );

-- ---- study_guide_answers ----------------------------------------------------

CREATE POLICY "Managers can view study guide answers"
  ON public.study_guide_answers
  FOR SELECT
  USING (public.can_manage_offering(offering_id));

CREATE POLICY "Students see their own study guide answers"
  ON public.study_guide_answers
  FOR SELECT
  USING (user_id = auth.uid());

-- Students insert their own answers only, and only for a guide published to
-- them. There is deliberately no UPDATE or DELETE policy: answers are
-- immutable once submitted.
--
-- The grading columns must be NULL on a student insert. Service-role grading
-- bypassing RLS is NOT sufficient on its own: without these predicates a
-- student could submit `grade`/`is_correct`/`feedback` in their own insert
-- payload and have the forged values persisted and shown to instructors.
-- Grading is applied afterwards by the service role, which bypasses RLS.
CREATE POLICY "Students submit their own study guide answers"
  ON public.study_guide_answers
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND public.study_guide_assigned_in_offering(study_guide_id, offering_id)
    AND is_correct IS NULL
    AND grade IS NULL
    AND feedback IS NULL
    AND strengths IS NULL
    AND areas_for_improvement IS NULL
    AND graded_at IS NULL
  );
