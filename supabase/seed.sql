-- Seed file for local development
-- Creates test users and comprehensive test data for e2e testing
-- Runs automatically on `supabase start` (or `supabase db reset`)

-- 1. Create a test institution (greek_school with academic period)
-- The insert fires the grade-levels seeding trigger, which calls
-- ensure_greek_grade_levels() and seeds the 12 grade_levels rows.
-- The seed data below looks up their ids by code.
INSERT INTO public.institutions (id, name, slug, institution_type, school_levels, academic_period)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Test Institution',
  'test-institution',
  'greek_school',
  ARRAY['dimotiko', 'gymnasio', 'lykeio'],
  '2025-2026'
)
ON CONFLICT (id) DO NOTHING;

-- 2. Create test users in auth.users via the Supabase auth schema helpers
-- Note: supabase local dev exposes a special function for seeding auth users.
-- We use raw inserts into auth.users + auth.identities (the approach Supabase recommends for seed files).

-- Helper to create an auth user with email/password
-- Uses exception handling instead of ON CONFLICT to work on both local and hosted Supabase
CREATE OR REPLACE FUNCTION _seed_create_user(
  _email text,
  _password text,
  _full_name text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  _user_id uuid;
  _encrypted_pw text := crypt(_password, gen_salt('bf'));
BEGIN
  -- Check if user already exists
  SELECT id INTO _user_id FROM auth.users WHERE email = _email;
  IF _user_id IS NOT NULL THEN
    RETURN _user_id;
  END IF;

  _user_id := gen_random_uuid();

  -- The older GoTrue that runs on Supabase preview branches scans EVERY
  -- character-varying column of auth.users when it looks a user up, and
  -- crashes on the first NULL: "converting NULL to string is unsupported"
  -- (surfaced to the client as HTTP 500 {"code":"unexpected_failure",
  -- "message":"Database error querying schema"} — login then never leaves
  -- /auth). A manual INSERT leaves these token columns NULL unless we set
  -- them, so set ALL of them to '' (semantically equivalent to NULL: no
  -- pending change / token). Setting only email_change + phone_change is
  -- not enough — the scan just crashes on the next NULL token column.
  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, encrypted_password,
    email_confirmed_at, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token,
    reauthentication_token,
    is_super_admin, raw_app_meta_data
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', _user_id, 'authenticated', 'authenticated',
    _email, _encrypted_pw,
    now(), jsonb_build_object('full_name', COALESCE(_full_name, '')),
    now(), now(),
    '', '',
    '', '', '',
    '', '',
    '',
    false, '{"provider":"email","providers":["email"]}'::jsonb
  );

  -- Create the identity entry so email/password login works
  BEGIN
    INSERT INTO auth.identities (
      id, user_id, provider_id, provider,
      identity_data, last_sign_in_at,
      created_at, updated_at
    ) VALUES (
      gen_random_uuid(), _user_id, _user_id::text, 'email',
      jsonb_build_object('sub', _user_id::text, 'email', _email),
      now(), now(), now()
    );
  EXCEPTION WHEN unique_violation THEN
    -- Identity already exists, skip
    NULL;
  END;

  RETURN _user_id;
END;
$$ LANGUAGE plpgsql;

-- 3. Create test users and all seed data
DO $$
DECLARE
  _student_id uuid;
  _instructor_id uuid;
  _admin_id uuid;
  _super_admin_id uuid;
  _evaluator_id uuid;
  -- Two extra classmates for the 1Α roster. `analyze-quiz` needs MIN_SUBMISSIONS
  -- (3) distinct submitters before it produces a real report instead of the
  -- `insufficientData` branch, and the follow-up-practice flow needs that report
  -- to have a target. One student can never satisfy either. See #1066.
  --
  -- Their names deliberately do NOT contain "Test Student":
  -- study-guide-analytics.spec.ts locates its row with
  -- `filter({ hasText: 'Test Student' })`, a SUBSTRING match, so a name like
  -- "Test Student B" would resolve to two rows and break it.
  _student2_id uuid;
  _student3_id uuid;
  -- Dedicated user for the TOTP login-challenge spec (mfa-totp.spec.ts). It
  -- gets a pre-seeded VERIFIED factor with a fixed secret, because a factor
  -- enrolled by a test run leaves the account challenge-locked for the next
  -- run, whose spec cannot know the generated secret. A fixed seeded secret
  -- makes the challenge deterministic and the spec idempotent. Nothing else
  -- logs in as this user — the five auth.setup.ts roles stay MFA-free.
  _mfa_user_id uuid;
  _institution_id uuid := '00000000-0000-0000-0000-000000000001';
  _student_ui_id uuid; -- user_institutions.id for student
  _student2_ui_id uuid;
  _student3_ui_id uuid;

  -- Classes (grade level + section)
  _class_1a_id uuid := '00000000-0000-0000-0001-000000000001';
  _class_1b_id uuid := '00000000-0000-0000-0001-000000000002';
  _class_1c_id uuid := '00000000-0000-0000-0001-000000000003';
  _class_2a_id uuid := '00000000-0000-0000-0001-000000000004';

  -- Courses
  _math_course_id uuid := '00000000-0000-0000-0002-000000000001';
  _lang_course_id uuid := '00000000-0000-0000-0002-000000000002';

  -- Offerings (course x section)
  _math_1a_offering_id uuid := '00000000-0000-0000-0003-000000000001';
  _math_1b_offering_id uuid := '00000000-0000-0000-0003-000000000002';
  _math_1c_offering_id uuid := '00000000-0000-0000-0003-000000000003';
  _lang_1a_offering_id uuid := '00000000-0000-0000-0003-000000000004';
  _lang_1b_offering_id uuid := '00000000-0000-0000-0003-000000000005';

  -- Course materials & chapters
  _material_id uuid := '00000000-0000-0000-0005-000000000001';
  _chapter1_id uuid := '00000000-0000-0000-0006-000000000001';
  _chapter2_id uuid := '00000000-0000-0000-0006-000000000002';

  -- Questions (MCQ)
  _q1_id uuid := '00000000-0000-0000-0007-000000000001';
  _q2_id uuid := '00000000-0000-0000-0007-000000000002';
  _q3_id uuid := '00000000-0000-0000-0007-000000000003';
  _q4_id uuid := '00000000-0000-0000-0007-000000000004';
  _q5_id uuid := '00000000-0000-0000-0007-000000000005';
  _q6_id uuid := '00000000-0000-0000-0007-000000000006';

  -- Quiz
  _quiz_id uuid := '00000000-0000-0000-0008-000000000001';
  -- A SECOND quiz, assigned closed (#1066). It has to be its own quiz rather
  -- than a second assignment of _quiz_id: offering_quizzes is
  -- UNIQUE (offering_id, quiz_id), so the same quiz cannot be both the open
  -- assignment student-happy-path takes and a closed one.
  _closed_quiz_id uuid := '00000000-0000-0000-0008-000000000002';

  -- Quiz questions
  _qq1_id uuid := '00000000-0000-0000-0009-000000000001';
  _qq2_id uuid := '00000000-0000-0000-0009-000000000002';
  _qq3_id uuid := '00000000-0000-0000-0009-000000000003';
  _cqq1_id uuid := '00000000-0000-0000-0009-000000000011';
  _cqq2_id uuid := '00000000-0000-0000-0009-000000000012';
  _cqq3_id uuid := '00000000-0000-0000-0009-000000000013';

  -- Closed-quiz MCQs (#1066). Deliberately NEW questions rather than a reuse of
  -- _q1..._q6: quiz_answers is unique on (user_id, question_id, session_id) and
  -- the seeded answers below would otherwise collide with — or pre-empt — the
  -- rows student-happy-path writes when it takes the OPEN quiz, and the rows the
  -- practice surface writes for _q3/_q5/_q6.
  _cq1_id uuid := '00000000-0000-0000-0007-000000000011';
  _cq2_id uuid := '00000000-0000-0000-0007-000000000012';
  _cq3_id uuid := '00000000-0000-0000-0007-000000000013';

  -- Open questions
  _oq1_id uuid := '00000000-0000-0000-000a-000000000001';
  _oq2_id uuid := '00000000-0000-0000-000a-000000000002';
  -- #1066 — the ONLY single-mode open question. _oq1/_oq2 carry an empty payload,
  -- which `openAnsweringModeFromPayload` resolves to "interactive", and the
  -- practice pool drops interactive rows — so without this one `submit-open-answer`
  -- has no surface to run on and its E2E skips even on a fresh target.
  _oq3_id uuid := '00000000-0000-0000-000a-000000000003';

  -- Study session
  _study_session_id uuid := '00000000-0000-0000-000b-000000000001';

  -- Offering quiz
  _offering_quiz_id uuid := '00000000-0000-0000-000c-000000000001';
  _offering_closed_quiz_id uuid := '00000000-0000-0000-000c-000000000002';

  -- Offering study session
  _offering_ss_id uuid := '00000000-0000-0000-000d-000000000001';

  -- Invitation
  _invitation_id uuid := '00000000-0000-0000-000e-000000000001';

  -- Offering questions — publish the non-quiz MCQs as PRACTICE, _oq1/_oq2 as
  -- INTERACTIVE (Socratic) and _oq3 as SINGLE to the 1Α offering, so the student
  -- Practice Questions and AI Interactive Questions surfaces are both non-empty
  -- and single-answer grading has something to run on (#1066).
  _offq_q3_id  uuid := '00000000-0000-0000-000f-000000000001';
  _offq_q5_id  uuid := '00000000-0000-0000-000f-000000000002';
  _offq_q6_id  uuid := '00000000-0000-0000-000f-000000000003';
  _offq_oq1_id uuid := '00000000-0000-0000-000f-000000000004';
  _offq_oq2_id uuid := '00000000-0000-0000-000f-000000000005';
  _offq_oq3_id uuid := '00000000-0000-0000-000f-000000000006';

  -- Offering chapter flashcards — publish chapter 1's flashcards to the 1Α
  -- offering so the student Flashcards review surface is non-empty.
  _offering_flashcards_ch1_id uuid := '00000000-0000-0000-0010-000000000001';

  -- Study guide (#977–#981) — a two-piece guide, deliberately NOT assigned to
  -- any offering. The study-guide analytics E2E assigns it itself, which is
  -- the first leg of the chain it has to prove.
  --
  -- Its questions carry NO competency_id, on purpose. Seeding
  -- `course_competencies` for Μαθηματικά would break
  -- ai-content-ingestion.spec.ts, which asserts the course has none before it
  -- runs extraction (`expect(before).toBe(0)`), and moving the guide to Γλώσσα
  -- to dodge that would break the evaluator sim scenarios that rely on Γλώσσα
  -- having an empty question bank. So the analytics E2E exercises the
  -- unattributed-bucket path instead — itself an acceptance criterion of #981 —
  -- and the attributed roll-up is covered by the unit and handler tests.
  _guide_id uuid    := '00000000-0000-0000-0012-000000000001';
  _piece1_id uuid   := '00000000-0000-0000-0013-000000000001';
  _piece2_id uuid   := '00000000-0000-0000-0013-000000000002';
  _sgq1_id uuid     := '00000000-0000-0000-0014-000000000001';
  _sgq2_id uuid     := '00000000-0000-0000-0014-000000000002';
  _sgq3_id uuid     := '00000000-0000-0000-0014-000000000003';
  _sgq4_id uuid     := '00000000-0000-0000-0014-000000000004';

  -- Second study guide: a READ-ONLY fixture for the sequential player's
  -- read-ahead guarantee (#1033). Pre-assigned to 1Α and never submitted
  -- against, so the student is permanently at position 0 and piece 2 stays
  -- locked. Piece 2's stems/options are deliberate canaries the E2E asserts
  -- never reach the browser. Kept separate from the guide above precisely
  -- because that one IS mutated (the analytics spec answers piece 1).
  _ra_guide_id uuid       := '00000000-0000-0000-0012-000000000002';
  _ra_piece1_id uuid      := '00000000-0000-0000-0013-000000000003';
  _ra_piece2_id uuid      := '00000000-0000-0000-0013-000000000004';
  _ra_sgq1_id uuid        := '00000000-0000-0000-0014-000000000005';
  _ra_sgq2_id uuid        := '00000000-0000-0000-0014-000000000006';
  _ra_sgq3_id uuid        := '00000000-0000-0000-0014-000000000007';
  _ra_sgq4_id uuid        := '00000000-0000-0000-0014-000000000008';
  _ra_offering_sg_id uuid := '00000000-0000-0000-0015-000000000001';

  -- Grade level IDs (looked up from grade_levels after institution insert seeded them)
  _gl_dimotiko_1 uuid;
  _gl_dimotiko_2 uuid;

BEGIN
  -- Resolve grade_level_ids for the two grades this seed uses.
  -- ensure_greek_grade_levels() ran automatically when the institution was
  -- created above with school_levels set.
  SELECT id INTO _gl_dimotiko_1
    FROM public.grade_levels
    WHERE institution_id = _institution_id AND code = 'dimotiko_1';
  SELECT id INTO _gl_dimotiko_2
    FROM public.grade_levels
    WHERE institution_id = _institution_id AND code = 'dimotiko_2';
  IF _gl_dimotiko_1 IS NULL OR _gl_dimotiko_2 IS NULL THEN
    RAISE EXCEPTION 'seed.sql: grade_levels rows for dimotiko_1/dimotiko_2 not found — did the trigger fire?';
  END IF;

  -- Create users
  _student_id     := _seed_create_user('e2e-student@test.local',     'testpass123', 'Test Student');
  _instructor_id  := _seed_create_user('e2e-instructor@test.local',  'testpass123', 'Test Instructor');
  _admin_id       := _seed_create_user('e2e-admin@test.local',       'testpass123', 'Test Admin');
  _super_admin_id := _seed_create_user('e2e-superadmin@test.local',  'testpass123', 'Test Super Admin');
  _evaluator_id   := _seed_create_user('e2e-evaluator@test.local',   'testpass123', 'Test Evaluator');
  -- Classmates (#1066). No E2E logs in as these two — they exist to give the
  -- 1Α roster enough submitters for a real quiz analysis.
  _student2_id    := _seed_create_user('e2e-classmate-a@test.local',  'testpass123', 'Μαρία Παπαδοπούλου');
  _student3_id    := _seed_create_user('e2e-classmate-b@test.local',  'testpass123', 'Νίκος Γεωργίου');
  _mfa_user_id    := _seed_create_user('e2e-mfa@test.local',          'testpass123', 'Test MFA Student');

  -- Verified TOTP factor with a fixed secret (the RFC 6238 test vector,
  -- base32 of "12345678901234567890"). mfa-totp.spec.ts generates codes from
  -- the same constant. GoTrue stores TOTP secrets in plaintext base32, so a
  -- seeded row behaves exactly like an enrolled one.
  INSERT INTO auth.mfa_factors (
    id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret
  ) VALUES (
    '00000000-0000-0000-000a-000000000001', _mfa_user_id, 'Authenticator app',
    'totp', 'verified', now(), now(), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  )
  ON CONFLICT DO NOTHING;

  -- The super-admin is MANDATED to have MFA (is_super_admin demands an aal2
  -- session outright), so the seeded super-admin carries a verified factor
  -- with the same fixed secret — auth.setup.ts completes the TOTP challenge
  -- at login with codes generated from it.
  INSERT INTO auth.mfa_factors (
    id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret
  ) VALUES (
    '00000000-0000-0000-000a-000000000002', _super_admin_id, 'Authenticator app',
    'totp', 'verified', now(), now(), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  )
  ON CONFLICT DO NOTHING;

  -- Assign roles via user_institutions
  INSERT INTO public.user_institutions (user_id, institution_id, role)
  VALUES
    (_student_id,    _institution_id, 'student'),
    (_student2_id,   _institution_id, 'student'),
    (_student3_id,   _institution_id, 'student'),
    (_mfa_user_id,   _institution_id, 'student'),
    (_instructor_id, _institution_id, 'instructor'),
    (_admin_id,      _institution_id, 'admin'),
    (_evaluator_id,  _institution_id, 'evaluator')
  ON CONFLICT (user_id, institution_id) DO NOTHING;

  -- Make super admin
  INSERT INTO public.super_admins (email)
  VALUES ('e2e-superadmin@test.local')
  ON CONFLICT (email) DO NOTHING;

  -- Also give super admin an institution membership (admin role)
  INSERT INTO public.user_institutions (user_id, institution_id, role)
  VALUES (_super_admin_id, _institution_id, 'admin')
  ON CONFLICT (user_id, institution_id) DO NOTHING;

  -- Get the student's user_institutions.id for user_institution_grades
  SELECT id INTO _student_ui_id FROM public.user_institutions
    WHERE user_id = _student_id AND institution_id = _institution_id;
  SELECT id INTO _student2_ui_id FROM public.user_institutions
    WHERE user_id = _student2_id AND institution_id = _institution_id;
  SELECT id INTO _student3_ui_id FROM public.user_institutions
    WHERE user_id = _student3_id AND institution_id = _institution_id;

  -- Student grade level (dimotiko_1)
  INSERT INTO public.user_institution_grades (user_institution_id, grade_level_id)
  VALUES
    (_student_ui_id,  _gl_dimotiko_1),
    (_student2_ui_id, _gl_dimotiko_1),
    (_student3_ui_id, _gl_dimotiko_1)
  ON CONFLICT (user_institution_id, grade_level_id) DO NOTHING;

  -------------------------------------------------------
  -- CLASSES (grade levels + sections)
  -------------------------------------------------------
  INSERT INTO public.classes (id, institution_id, name, grade_level_id, section_name, academic_period)
  VALUES
    (_class_1a_id, _institution_id, 'Τμήμα 1Α', _gl_dimotiko_1, 'Α', '2025-2026'),
    (_class_1b_id, _institution_id, 'Τμήμα 1Β', _gl_dimotiko_1, 'Β', '2025-2026'),
    (_class_1c_id, _institution_id, 'Τμήμα 1Γ', _gl_dimotiko_1, 'Γ', '2025-2026'),
    (_class_2a_id, _institution_id, 'Τμήμα 2Α', _gl_dimotiko_2, 'Α', '2025-2026')
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- COURSES
  -------------------------------------------------------
  INSERT INTO public.courses (id, institution_id, title, description, grade_level_id, created_by)
  VALUES
    (_math_course_id, _institution_id, 'Μαθηματικά', 'Μαθηματικά για 1η Δημοτικού', _gl_dimotiko_1, _instructor_id),
    (_lang_course_id, _institution_id, 'Γλώσσα', 'Γλώσσα για 1η Δημοτικού', _gl_dimotiko_1, _instructor_id)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- OFFERINGS (course x section)
  -------------------------------------------------------
  INSERT INTO public.offerings (id, course_id, class_id, is_active)
  VALUES
    -- Μαθηματικά → all 3 sections of 1η Δημοτικού
    (_math_1a_offering_id, _math_course_id, _class_1a_id, true),
    (_math_1b_offering_id, _math_course_id, _class_1b_id, true),
    (_math_1c_offering_id, _math_course_id, _class_1c_id, true),
    -- Γλώσσα → sections 1Α and 1Β only
    (_lang_1a_offering_id, _lang_course_id, _class_1a_id, true),
    (_lang_1b_offering_id, _lang_course_id, _class_1b_id, true)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- COURSE INSTRUCTORS
  -------------------------------------------------------
  INSERT INTO public.course_instructors (course_id, user_id)
  VALUES
    (_math_course_id, _instructor_id),
    (_lang_course_id, _instructor_id)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- COURSE INSTRUCTOR SECTIONS (restriction: Γλώσσα → 1Α only)
  -------------------------------------------------------
  INSERT INTO public.course_instructor_sections (course_id, class_id, user_id)
  VALUES
    (_lang_course_id, _class_1a_id, _instructor_id)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- COURSE EVALUATORS (#702) — assign the evaluator to both seeded
  -- courses so /evaluator shows a non-empty workspace on first login
  -- and there is a question bank for /sim-evaluator scenarios to drive.
  -------------------------------------------------------
  INSERT INTO public.course_evaluators (course_id, user_id)
  VALUES
    (_math_course_id, _evaluator_id),
    (_lang_course_id, _evaluator_id)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- CLASS ENROLLMENTS (student → section 1Α)
  -------------------------------------------------------
  INSERT INTO public.class_enrollments (user_id, class_id, role)
  VALUES
    (_student_id,  _class_1a_id, 'student'),
    (_student2_id, _class_1a_id, 'student'),
    (_student3_id, _class_1a_id, 'student')
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- COURSE MATERIALS (1 material for Μαθηματικά)
  -------------------------------------------------------
  INSERT INTO public.course_materials (id, course_id, file_name, file_url, title, description, material_type, uploaded_by)
  VALUES (
    _material_id,
    _math_course_id,
    'mathimatika-biblio.pdf',
    'https://example.com/placeholder.pdf',
    'Βιβλίο Μαθηματικών',
    'Σχολικό βιβλίο μαθηματικών για 1η Δημοτικού',
    'textbook',
    _instructor_id
  )
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- MATERIAL CHAPTERS (2 chapters)
  -------------------------------------------------------
  -- Chapter 1: flashcards + cheat sheet
  INSERT INTO public.material_chapters (id, material_id, title, chapter_number, content_type, content, flashcards, flashcards_visible, cheat_sheet, cheat_sheet_visible)
  VALUES (
    _chapter1_id,
    _material_id,
    'Αριθμοί 1-10',
    1,
    'text',
    'Σε αυτό το κεφάλαιο μαθαίνουμε τους αριθμούς από το 1 μέχρι το 10. Κάθε αριθμός έχει ένα σύμβολο και μια λέξη.',
    '[{"front": "Πόσο κάνει 2 + 3;", "back": "5"}, {"front": "Πόσο κάνει 4 + 1;", "back": "5"}, {"front": "Ποιος αριθμός έρχεται μετά το 7;", "back": "8"}]'::jsonb,
    true,
    'Βασικοί κανόνες πρόσθεσης: Η πρόσθεση είναι αντιμεταθετική (2+3 = 3+2). Το 0 είναι το ουδέτερο στοιχείο.',
    true
  )
  ON CONFLICT DO NOTHING;

  -- Chapter 2: text content only
  INSERT INTO public.material_chapters (id, material_id, title, chapter_number, content_type, content)
  VALUES (
    _chapter2_id,
    _material_id,
    'Σχήματα',
    2,
    'text',
    'Σε αυτό το κεφάλαιο μαθαίνουμε τα βασικά γεωμετρικά σχήματα: κύκλος, τρίγωνο, τετράγωνο και ορθογώνιο.'
  )
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- QUESTIONS (6 MCQ for Μαθηματικά)
  -------------------------------------------------------
  -- Seeded MCQs carry an explicit AI-validation verdict. Two surfaces drop an
  -- mcq whose `validation_status` is NULL, so without it the seed is invisible:
  --   * the quiz/test builder bank only renders an mcq that passed validation
  --     (AssessmentQuestionBank `isMcqVerified`: CORRECT and confidence > 0.7);
  --   * the student practice query filters `validation_status <> 'INCORRECT'`,
  --     which SQL three-valued logic evaluates as NULL — so NULL rows drop too.
  -- Leaving these NULL made the builder bank empty on pure seed data, so
  -- quiz-creation.spec.ts only passed when an earlier ai-* spec happened to
  -- leave a validated question behind (#964).
  -- 3 easy
  INSERT INTO public.questions (id, course_id, question, type, payload, answer_key, difficulty, explanation, created_by,
                                validation_status, validation_confidence, validation_message, validated_at)
  VALUES
    (_q1_id, _math_course_id, 'Πόσο κάνει 1 + 1;',
     'mcq', '{"options": ["1", "2", "3", "4"]}'::jsonb, '{"correct_index": 1}'::jsonb, 'easy',
     'Η πρόσθεση 1 + 1 δίνει 2.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
    (_q2_id, _math_course_id, 'Πόσο κάνει 2 + 1;',
     'mcq', '{"options": ["2", "3", "4", "5"]}'::jsonb, '{"correct_index": 1}'::jsonb, 'easy',
     'Η πρόσθεση 2 + 1 δίνει 3.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
    (_q3_id, _math_course_id, 'Ποιος αριθμός έρχεται μετά το 5;',
     'mcq', '{"options": ["4", "5", "6", "7"]}'::jsonb, '{"correct_index": 2}'::jsonb, 'easy',
     'Μετά το 5 έρχεται το 6.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
  -- 2 medium
    (_q4_id, _math_course_id, 'Πόσο κάνει 3 + 4;',
     'mcq', '{"options": ["5", "6", "7", "8"]}'::jsonb, '{"correct_index": 2}'::jsonb, 'medium',
     'Η πρόσθεση 3 + 4 δίνει 7.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
    (_q5_id, _math_course_id, 'Πόσο κάνει 5 + 5;',
     'mcq', '{"options": ["8", "9", "10", "11"]}'::jsonb, '{"correct_index": 2}'::jsonb, 'medium',
     'Η πρόσθεση 5 + 5 δίνει 10.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
  -- 1 hard
    (_q6_id, _math_course_id, 'Αν έχω 3 μήλα και μου δίνουν άλλα 4, πόσα μήλα έχω συνολικά;',
     'mcq', '{"options": ["5", "6", "7", "8"]}'::jsonb, '{"correct_index": 2}'::jsonb, 'hard',
     'Η πρόσθεση 3 + 4 δίνει 7 μήλα.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now())
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- CLOSED-QUIZ MCQs (#1066)
  -------------------------------------------------------
  -- Subtraction, where the seeded answers below put every wrong answer on the
  -- same question (_cq3). That gives `analyze-quiz` an actual misconception to
  -- report rather than uniform noise, and gives the follow-up-practice flow a
  -- concrete weak topic to target.
  INSERT INTO public.questions (id, course_id, question, type, payload, answer_key, difficulty, explanation, created_by,
                                validation_status, validation_confidence, validation_message, validated_at)
  VALUES
    (_cq1_id, _math_course_id, 'Πόσο κάνει 5 - 2;',
     'mcq', '{"options": ["2", "3", "4", "5"]}'::jsonb, '{"correct_index": 1}'::jsonb, 'easy',
     'Η αφαίρεση 5 - 2 δίνει 3.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
    (_cq2_id, _math_course_id, 'Πόσο κάνει 9 - 4;',
     'mcq', '{"options": ["3", "4", "5", "6"]}'::jsonb, '{"correct_index": 2}'::jsonb, 'easy',
     'Η αφαίρεση 9 - 4 δίνει 5.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now()),
    (_cq3_id, _math_course_id, 'Πόσο κάνει 12 - 7;',
     'mcq', '{"options": ["4", "5", "6", "7"]}'::jsonb, '{"correct_index": 1}'::jsonb, 'medium',
     'Η αφαίρεση 12 - 7 δίνει 5.', _instructor_id,
     'CORRECT', 0.95, 'Seeded question — pre-validated for deterministic E2E runs.', now())
  ON CONFLICT DO NOTHING;

  -- Bind them to chapter 1. `enqueue-followup-practice` resolves a quiz's source
  -- material through `question_chapters` and returns 400 `no_chapters` when the
  -- set is empty ("This quiz's questions aren't linked to any course chapters"),
  -- so a closed quiz with submissions is still not enough on its own — the
  -- follow-up spec ran for the first time once the board expanded correctly, and
  -- failed exactly here.
  --
  -- Only the closed-quiz MCQs get this link. _q1.._q6 stay unlinked so nothing
  -- that relies on the seed's existing shape changes.
  INSERT INTO public.question_chapters (question_id, chapter_id)
  VALUES
    (_cq1_id, _chapter1_id),
    (_cq2_id, _chapter1_id),
    (_cq3_id, _chapter1_id)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- OPEN QUESTIONS (2 for Μαθηματικά)
  -------------------------------------------------------
  INSERT INTO public.questions (id, course_id, question, type, payload, answer_key, difficulty, created_by)
  VALUES
    (_oq1_id, _math_course_id,
     'Εξήγησε γιατί 2 + 3 είναι το ίδιο με 3 + 2.',
     'open', '{}'::jsonb,
     jsonb_build_object(
       'model_answer', 'Η πρόσθεση είναι αντιμεταθετική. Αυτό σημαίνει ότι δεν έχει σημασία η σειρά των αριθμών. Αν βάλω 2 μήλα σε ένα καλάθι και μετά 3 ακόμα, έχω 5. Αν βάλω πρώτα 3 και μετά 2, πάλι έχω 5.',
       'rubric', null,
       'explanation', null
     ),
     'easy', _instructor_id),
    (_oq2_id, _math_course_id,
     'Περίγραψε τη διαφορά μεταξύ κύκλου και τετραγώνου.',
     'open', '{}'::jsonb,
     jsonb_build_object(
       'model_answer', 'Ο κύκλος είναι στρογγυλός και δεν έχει γωνίες ή πλευρές. Το τετράγωνο έχει 4 ίσες πλευρές και 4 ορθές γωνίες. Ο κύκλος κυλάει ενώ το τετράγωνο δεν κυλάει.',
       'rubric', null,
       'explanation', null
     ),
     'medium', _instructor_id),
  -- #1066 — single-answer mode. `openAnsweringModeFromPayload` reads
  -- `payload.answering_mode` and treats anything but "single" as "interactive",
  -- so this is the one open question the practice pool will surface and the one
  -- `submit-open-answer` can be driven from.
    (_oq3_id, _math_course_id,
     'Γιατί το 10 - 4 δεν είναι το ίδιο με το 4 - 10;',
     'open', '{"answering_mode": "single"}'::jsonb,
     jsonb_build_object(
       'model_answer', 'Η αφαίρεση δεν είναι αντιμεταθετική. Το 10 - 4 σημαίνει ότι ξεκινάω από το 10 και αφαιρώ 4, οπότε μένουν 6. Το 4 - 10 σημαίνει ότι ξεκινάω από το 4 και προσπαθώ να αφαιρέσω 10, που δεν γίνεται με τους φυσικούς αριθμούς.',
       'rubric', null,
       'explanation', null
     ),
     'medium', _instructor_id)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- QUIZ (1 published quiz with 3 MCQ questions)
  -------------------------------------------------------
  -- show_answers = true so a student who takes this quiz can review the answers
  -- straight away in Quiz History. The student-happy-path E2E relies on it (it
  -- has no service-role key to release answers itself), and this assignment has
  -- to stay OPEN for that same test to be able to take the quiz — which rules
  -- out offering_quizzes.answers_released, gated on closure since migration
  -- 20260907120000.
  INSERT INTO public.quizzes (id, course_id, title, description, is_published, show_answers, created_by)
  VALUES (
    _quiz_id,
    _math_course_id,
    'Κουίζ Αριθμών 1-10',
    'Βασικό κουίζ πρόσθεσης για τους αριθμούς 1 μέχρι 10',
    true,
    true,
    _instructor_id
  )
  ON CONFLICT DO NOTHING;

  -- Link 3 questions to quiz
  INSERT INTO public.quiz_questions (id, quiz_id, question_id, order_num)
  VALUES
    (_qq1_id, _quiz_id, _q1_id, 1),
    (_qq2_id, _quiz_id, _q2_id, 2),
    (_qq3_id, _quiz_id, _q4_id, 3)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- CLOSED QUIZ (#1066) — a second published quiz over the subtraction MCQs
  -------------------------------------------------------
  INSERT INTO public.quizzes (id, course_id, title, description, is_published, created_by)
  VALUES (
    _closed_quiz_id,
    _math_course_id,
    'Κουίζ Αφαίρεσης (ολοκληρωμένο)',
    'Ολοκληρωμένο κουίζ αφαίρεσης — χρησιμοποιείται για ανάλυση τάξης',
    true,
    _instructor_id
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.quiz_questions (id, quiz_id, question_id, order_num)
  VALUES
    (_cqq1_id, _closed_quiz_id, _cq1_id, 1),
    (_cqq2_id, _closed_quiz_id, _cq2_id, 2),
    (_cqq3_id, _closed_quiz_id, _cq3_id, 3)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- OFFERING QUIZZES (publish quiz to 1Α offering)
  -------------------------------------------------------
  -- Open/takeable: closed_at stays NULL, so answers_released must stay false —
  -- an assignment may only release answers once it is marked as done. Review of
  -- this quiz's answers comes from quizzes.show_answers instead (see above).
  INSERT INTO public.offering_quizzes (id, offering_id, quiz_id, published_at, answers_released, closed_at)
  VALUES (
    _offering_quiz_id,
    _math_1a_offering_id,
    _quiz_id,
    now(),
    false,
    NULL
  )
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- CLOSED OFFERING QUIZ + SUBMISSIONS (#1066)
  -------------------------------------------------------
  -- A SECOND assignment on the same offering, this one closed. The open one
  -- above is left exactly as it was — student-happy-path still needs a takeable
  -- quiz — which is why this needed its own quiz_id (offering_quizzes is
  -- UNIQUE (offering_id, quiz_id)).
  --
  -- `closed_at` is what makes the instructor's "Analyze quiz" action render
  -- (AssignedQuizzesBoard: `isClosed = assignment.closedAt !== null`) and what
  -- analyze-quiz itself demands before it will run.
  INSERT INTO public.offering_quizzes (id, offering_id, quiz_id, published_at, answers_released, closed_at)
  VALUES (
    _offering_closed_quiz_id,
    _math_1a_offering_id,
    _closed_quiz_id,
    now() - interval '7 days',
    true,
    now() - interval '1 day'
  )
  ON CONFLICT DO NOTHING;

  -- Submissions from all three classmates. analyze-quiz counts DISTINCT
  -- submitters and needs MIN_SUBMISSIONS (3) before it returns a report instead
  -- of `insufficientData` — which is also what the follow-up-practice flow needs
  -- in order to find a target. Everyone gets _cq1/_cq2 right and _cq3 wrong, so
  -- the analysis has one unambiguous weak spot to name.
  --
  -- session_id stays NULL: these are seeded results, not a replay of the
  -- StudentQuiz session flow, and analyze-quiz keys on (quiz_id, offering_id,
  -- user_id) rather than on the session.
  --
  -- Explicit ids + ON CONFLICT (id) rather than a bare ON CONFLICT: the table's
  -- unique key is (user_id, question_id, session_id), and with session_id NULL
  -- Postgres counts every row as distinct (NULLS DISTINCT), so a bare conflict
  -- clause would never fire and a re-run of this seed would silently double
  -- every submission — inflating exactly the counts analyze-quiz reasons about.
  INSERT INTO public.quiz_answers (id, user_id, question_id, course_id, quiz_id, offering_id, selected_answer, is_correct, answered_at)
  VALUES
    ('00000000-0000-0000-0011-000000000001', _student_id,  _cq1_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 1, true,  now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000002', _student_id,  _cq2_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 2, true,  now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000003', _student_id,  _cq3_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 0, false, now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000004', _student2_id, _cq1_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 1, true,  now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000005', _student2_id, _cq2_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 2, true,  now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000006', _student2_id, _cq3_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 2, false, now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000007', _student3_id, _cq1_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 1, true,  now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000008', _student3_id, _cq2_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 2, true,  now() - interval '2 days'),
    ('00000000-0000-0000-0011-000000000009', _student3_id, _cq3_id, _math_course_id, _closed_quiz_id, _math_1a_offering_id, 3, false, now() - interval '2 days')
  ON CONFLICT (id) DO NOTHING;

  -------------------------------------------------------
  -- OFFERING QUESTIONS (publish practice + interactive to 1Α offering)
  -------------------------------------------------------
  -- Practice: the 3 MCQs NOT bound to the timed quiz (_q1/_q2/_q4 are quiz
  -- members and are excluded from the practice surface by design). Interactive:
  -- both open questions — their empty payload resolves to answering_mode
  -- "interactive", which the AI Interactive Questions surface consumes.
  INSERT INTO public.offering_questions (id, offering_id, question_id, published_at)
  VALUES
    (_offq_q3_id,  _math_1a_offering_id, _q3_id,  now()),
    (_offq_q5_id,  _math_1a_offering_id, _q5_id,  now()),
    (_offq_q6_id,  _math_1a_offering_id, _q6_id,  now()),
    (_offq_oq1_id, _math_1a_offering_id, _oq1_id, now()),
    (_offq_oq2_id, _math_1a_offering_id, _oq2_id, now()),
    -- #1066 — the single-mode open question, which lands in the PRACTICE pool
    -- (useStudentPracticeQuestions drops interactive-mode open rows) rather than
    -- the AI Interactive Questions surface.
    (_offq_oq3_id, _math_1a_offering_id, _oq3_id, now())
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- OFFERING CHAPTER FLASHCARDS (publish chapter 1 to 1Α offering)
  -------------------------------------------------------
  -- Chapter 1 already has flashcards + flashcards_visible = true; the student
  -- Flashcards surface additionally requires the chapter to be published to
  -- the offering via offering_chapter_flashcards.
  INSERT INTO public.offering_chapter_flashcards (id, offering_id, chapter_id, published_at)
  VALUES (
    _offering_flashcards_ch1_id,
    _math_1a_offering_id,
    _chapter1_id,
    now()
  )
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- STUDY SESSION (linked to chapter 1)
  -------------------------------------------------------
  INSERT INTO public.study_sessions (id, course_id, title, topic, chapter_id, status, created_by)
  VALUES (
    _study_session_id,
    _math_course_id,
    'Μελέτη: Αριθμοί 1-10',
    'Αριθμοί και βασική πρόσθεση',
    _chapter1_id,
    'ready',
    _instructor_id
  )
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- OFFERING STUDY SESSIONS (publish to 1Α offering)
  -------------------------------------------------------
  INSERT INTO public.offering_study_sessions (id, offering_id, study_session_id, published_at)
  VALUES (
    _offering_ss_id,
    _math_1a_offering_id,
    _study_session_id,
    now()
  )
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- STUDY GUIDE (2 pieces × 2 MCQs, NOT assigned)
  -------------------------------------------------------
  -- Deliberately unassigned: the study-guide analytics E2E (#981) assigns it
  -- to a section as the first step of the chain it exercises. Every question
  -- is MCQ so the whole submit path is deterministic — `submit-study-guide-
  -- piece` grades MCQs locally and never calls OpenAI, which keeps that spec
  -- out of the @ai bucket.
  INSERT INTO public.study_guides (
    id, course_id, material_id, title, brief,
    target_piece_count, target_questions_per_piece, created_by
  )
  VALUES (
    _guide_id, _math_course_id, _material_id,
    'Οδηγός Μελέτης: Πρόσθεση και Αφαίρεση',
    'Δύο βήματα: πρώτα η πρόσθεση, μετά η αφαίρεση.',
    2, 2, _instructor_id
  )
  ON CONFLICT DO NOTHING;

  -- Both staleness stamps are set explicitly and equal: the manager marks a
  -- piece stale when its questions PREDATE its theory, and the trigger that
  -- maintains theory_updated_at only fires on UPDATE, so an insert that left
  -- them NULL would depend on `pieceIsStale`'s null handling to look healthy.
  INSERT INTO public.study_guide_pieces (
    id, study_guide_id, position, title, theory_html,
    theory_updated_at, questions_generated_at
  )
  -- The theory carries LaTeX, because the generators are told to write maths
  -- with `$` delimiters and this is a maths course. Seeding it plain meant no
  -- local or preview environment ever exercised the rendering path, which is
  -- how theory shipped showing students raw `$...$`.
  VALUES
    (_piece1_id, _guide_id, 0, 'Πρόσθεση έως το 10',
     '<p>Όταν προσθέτουμε, ενώνουμε δύο ποσότητες σε μία: $4 + 3 = 7$.</p>', now(), now()),
    (_piece2_id, _guide_id, 1, 'Αφαίρεση έως το 10',
     '<p>Όταν αφαιρούμε, παίρνουμε μια ποσότητα από μια άλλη: $9 - 4 = 5$.</p>', now(), now())
  -- Targets the primary key explicitly. A bare `ON CONFLICT DO NOTHING`
  -- considers EVERY unique index on the table, and this one carries
  -- `UNIQUE (study_guide_id, position) DEFERRABLE` — which Postgres refuses as
  -- an arbiter ("ON CONFLICT does not support deferrable unique constraints"),
  -- failing the whole seed and with it every db reset and preview branch.
  ON CONFLICT (id) DO NOTHING;

  -- Study-guide questions live in the shared `questions` table;
  -- `study_guide_piece_questions` is the only marker separating them from the
  -- Question Bank (see migration 20260727120000).
  INSERT INTO public.questions (
    id, course_id, question, type, payload, answer_key, difficulty, explanation,
    created_by, validation_status, validation_confidence,
    validation_message, validated_at
  )
  VALUES
    (_sgq1_id, _math_course_id, 'Πόσο κάνει 4 + 3;',
     'mcq', '{"options": ["6", "7", "8", "9"]}'::jsonb, '{"correct_index": 1}'::jsonb,
     'easy', 'Η πρόσθεση 4 + 3 δίνει 7.', _instructor_id,
     'CORRECT', 0.95, 'Seeded study-guide question.', now()),
    (_sgq2_id, _math_course_id, 'Πόσο κάνει 6 + 2;',
     'mcq', '{"options": ["7", "8", "9", "10"]}'::jsonb, '{"correct_index": 1}'::jsonb,
     'easy', 'Η πρόσθεση 6 + 2 δίνει 8.', _instructor_id,
     'CORRECT', 0.95, 'Seeded study-guide question.', now()),
    (_sgq3_id, _math_course_id, 'Πόσο κάνει 9 - 4;',
     'mcq', '{"options": ["3", "4", "5", "6"]}'::jsonb, '{"correct_index": 2}'::jsonb,
     'easy', 'Η αφαίρεση 9 - 4 δίνει 5.', _instructor_id,
     'CORRECT', 0.95, 'Seeded study-guide question.', now()),
    (_sgq4_id, _math_course_id, 'Πόσο κάνει 7 - 3;',
     'mcq', '{"options": ["2", "3", "4", "5"]}'::jsonb, '{"correct_index": 2}'::jsonb,
     'easy', 'Η αφαίρεση 7 - 3 δίνει 4.', _instructor_id,
     'CORRECT', 0.95, 'Seeded study-guide question.', now())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.study_guide_piece_questions (piece_id, question_id, position)
  VALUES
    (_piece1_id, _sgq1_id, 0),
    (_piece1_id, _sgq2_id, 1),
    (_piece2_id, _sgq3_id, 0),
    (_piece2_id, _sgq4_id, 1)
  ON CONFLICT DO NOTHING;

  -------------------------------------------------------
  -- STUDY GUIDE #2 (read-ahead fixture — PRE-ASSIGNED, never submitted)
  -------------------------------------------------------
  -- The read-only companion to the analytics/completion coverage. It exists so
  -- the browser suite can assert, in a real browser, the one
  -- property nothing else covers end to end: a LOCKED piece never ships its
  -- questions (or their answer_key) to the client. `StudyGuidePlayer` fetches
  -- piece content only for pieces at or before the student's position, so with
  -- this guide left unstarted piece 2 is unreachable and its rows are never
  -- requested — RLS would authorise them, so that client-side narrowing is the
  -- entire gate.
  --
  -- Why a SECOND guide rather than reusing the one above: that one is mutated
  -- (the analytics spec answers piece 1), and study-guide answers are immutable,
  -- so it cannot double as a "student is always at position 0" fixture. This one
  -- is assigned but must stay pristine — no progress, no answers seeded, and no
  -- spec ever submits against it — so every run sees piece 2 locked.
  INSERT INTO public.study_guides (
    id, course_id, material_id, title, brief,
    target_piece_count, target_questions_per_piece, created_by
  )
  VALUES (
    _ra_guide_id, _math_course_id, _material_id,
    'Read-Ahead Fixture — Ακολουθία Κομματιών',
    'Read-only E2E fixture: piece 2 must stay locked and unsent.',
    2, 2, _instructor_id
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.study_guide_pieces (
    id, study_guide_id, position, title, theory_html,
    theory_updated_at, questions_generated_at
  )
  VALUES
    (_ra_piece1_id, _ra_guide_id, 0, 'Reachable piece',
     '<p>This piece is reachable, so its content is delivered.</p>', now(), now()),
    (_ra_piece2_id, _ra_guide_id, 1, 'Locked piece',
     '<p>This piece is locked; its theory must never reach the browser.</p>', now(), now())
  -- PK-targeted for the same reason as the guide above: the table's
  -- `UNIQUE (study_guide_id, position)` is DEFERRABLE and cannot arbitrate
  -- ON CONFLICT, so a bare DO NOTHING would fail the whole seed.
  ON CONFLICT (id) DO NOTHING;

  -- Piece 2's stems AND options are canaries: the E2E asserts none of these
  -- strings appears in the DOM or in any network response while piece 2 is
  -- locked. Because a stem lives on the same `questions` row as `answer_key`,
  -- proving the stem never arrived proves the answer key never did either.
  INSERT INTO public.questions (
    id, course_id, question, type, payload, answer_key, difficulty, explanation,
    created_by, validation_status, validation_confidence,
    validation_message, validated_at
  )
  VALUES
    (_ra_sgq1_id, _math_course_id, 'Read-ahead fixture: reachable question one',
     'mcq', '{"options": ["1", "2", "3", "4"]}'::jsonb, '{"correct_index": 1}'::jsonb,
     'easy', 'Reachable fixture question.', _instructor_id,
     'CORRECT', 0.95, 'Seeded read-ahead fixture question.', now()),
    (_ra_sgq2_id, _math_course_id, 'Read-ahead fixture: reachable question two',
     'mcq', '{"options": ["5", "6", "7", "8"]}'::jsonb, '{"correct_index": 2}'::jsonb,
     'easy', 'Reachable fixture question.', _instructor_id,
     'CORRECT', 0.95, 'Seeded read-ahead fixture question.', now()),
    (_ra_sgq3_id, _math_course_id, 'READ-AHEAD CANARY: locked question one must not leak',
     'mcq', '{"options": ["canary-locked-1a", "canary-locked-1b", "canary-locked-1c", "canary-locked-1d"]}'::jsonb,
     '{"correct_index": 0}'::jsonb,
     'easy', 'Locked fixture question — must never reach the browser.', _instructor_id,
     'CORRECT', 0.95, 'Seeded read-ahead fixture question.', now()),
    (_ra_sgq4_id, _math_course_id, 'READ-AHEAD CANARY: locked question two must not leak',
     'mcq', '{"options": ["canary-locked-2a", "canary-locked-2b", "canary-locked-2c", "canary-locked-2d"]}'::jsonb,
     '{"correct_index": 3}'::jsonb,
     'easy', 'Locked fixture question — must never reach the browser.', _instructor_id,
     'CORRECT', 0.95, 'Seeded read-ahead fixture question.', now())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.study_guide_piece_questions (piece_id, question_id, position)
  VALUES
    (_ra_piece1_id, _ra_sgq1_id, 0),
    (_ra_piece1_id, _ra_sgq2_id, 1),
    (_ra_piece2_id, _ra_sgq3_id, 0),
    (_ra_piece2_id, _ra_sgq4_id, 1)
  ON CONFLICT DO NOTHING;

  -- Assigned to 1Α and published so the student sees the card; `published_at`
  -- is the "visible to the student" predicate. Deliberately NO progress or
  -- answer rows — those would advance the student past piece 0 and unlock the
  -- canary.
  INSERT INTO public.offering_study_guides (id, offering_id, study_guide_id, published_at)
  VALUES (_ra_offering_sg_id, _math_1a_offering_id, _ra_guide_id, now())
  ON CONFLICT (id) DO NOTHING;

  -------------------------------------------------------
  -- INVITATION (pending for new user)
  -------------------------------------------------------
  INSERT INTO public.invitations (id, email, institution_id, role, status, invited_by, invited_class_id, invited_grade_level_id)
  VALUES (
    _invitation_id,
    'e2e-newuser@test.local',
    _institution_id,
    'student',
    'pending',
    _admin_id,
    _class_1a_id,
    _gl_dimotiko_1
  )
  ON CONFLICT DO NOTHING;

END;
$$;

-- 4. Clean up the helper function
DROP FUNCTION IF EXISTS _seed_create_user;
