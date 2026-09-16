import { SupabaseClient } from '@supabase/supabase-js';

/** Insert helpers — all use service-role client (bypasses RLS) */

export async function createInstitution(
  admin: SupabaseClient,
  name: string
): Promise<string> {
  const slug = name.toLowerCase().replace(/\s+/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
  const { data, error } = await admin
    .from('institutions')
    .insert({ name, slug })
    .select('id')
    .single();
  if (error) throw new Error(`createInstitution: ${error.message}`);
  return data.id;
}

export async function createCourse(
  admin: SupabaseClient,
  institutionId: string,
  createdBy?: string
): Promise<string> {
  const { data, error } = await admin
    .from('courses')
    .insert({
      institution_id: institutionId,
      title: `RLS Test Course ${crypto.randomUUID().slice(0, 8)}`,
      created_by: createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCourse: ${error.message}`);
  return data.id;
}

export async function createClass(
  admin: SupabaseClient,
  institutionId: string
): Promise<string> {
  const { data, error } = await admin
    .from('classes')
    .insert({
      institution_id: institutionId,
      name: `RLS Test Class ${crypto.randomUUID().slice(0, 8)}`,
      is_active: true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createClass: ${error.message}`);
  return data.id;
}

export async function createOffering(
  admin: SupabaseClient,
  classId: string,
  courseId: string
): Promise<string> {
  const { data, error } = await admin
    .from('offerings')
    .insert({ class_id: classId, course_id: courseId, is_active: true })
    .select('id')
    .single();
  if (error) throw new Error(`createOffering: ${error.message}`);
  return data.id;
}

export async function enrollInClass(
  admin: SupabaseClient,
  classId: string,
  userId: string,
  role: 'student' | 'instructor' = 'student'
): Promise<void> {
  const { error } = await admin
    .from('class_enrollments')
    .insert({ class_id: classId, user_id: userId, role });
  if (error) throw new Error(`enrollInClass: ${error.message}`);
}

export async function assignCourseInstructor(
  admin: SupabaseClient,
  courseId: string,
  userId: string
): Promise<void> {
  const { error } = await admin
    .from('course_instructors')
    .insert({ course_id: courseId, user_id: userId });
  if (error) throw new Error(`assignCourseInstructor: ${error.message}`);
}

export async function assignCourseEvaluator(
  admin: SupabaseClient,
  courseId: string,
  userId: string
): Promise<void> {
  const { error } = await admin
    .from('course_evaluators')
    .insert({ course_id: courseId, user_id: userId });
  if (error) throw new Error(`assignCourseEvaluator: ${error.message}`);
}

export async function addSectionRestriction(
  admin: SupabaseClient,
  courseId: string,
  classId: string,
  userId: string
): Promise<void> {
  const { error } = await admin
    .from('course_instructor_sections')
    .insert({ course_id: courseId, class_id: classId, user_id: userId });
  if (error) throw new Error(`addSectionRestriction: ${error.message}`);
}

export async function addUserToInstitution(
  admin: SupabaseClient,
  userId: string,
  institutionId: string,
  role: 'student' | 'instructor' | 'admin' | 'evaluator'
): Promise<void> {
  const { error } = await admin
    .from('user_institutions')
    .insert({ user_id: userId, institution_id: institutionId, role });
  if (error) throw new Error(`addUserToInstitution: ${error.message}`);
}

export async function addSuperAdmin(
  admin: SupabaseClient,
  email: string
): Promise<void> {
  const { error } = await admin
    .from('super_admins')
    .insert({ email });
  if (error) throw new Error(`addSuperAdmin: ${error.message}`);
}

export async function createCourseMaterial(
  admin: SupabaseClient,
  courseId: string
): Promise<string> {
  const { data, error } = await admin
    .from('course_materials')
    .insert({
      course_id: courseId,
      file_name: 'rls-test.pdf',
      file_url: 'https://example.com/rls-test.pdf',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCourseMaterial: ${error.message}`);
  return data.id;
}

export async function createMaterialChapter(
  admin: SupabaseClient,
  materialId: string,
  chapterNumber: number = 1
): Promise<string> {
  const { data, error } = await admin
    .from('material_chapters')
    .insert({
      material_id: materialId,
      title: `RLS Test Chapter ${chapterNumber}`,
      chapter_number: chapterNumber,
      content_type: 'text',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createMaterialChapter: ${error.message}`);
  return data.id;
}

export async function createQuestion(
  admin: SupabaseClient,
  courseId: string,
  createdBy?: string
): Promise<string> {
  // Multi-correct unified MCQ shape (#582 + #592). `answer_key` carries
  // `correct_indices: number[]`; the legacy `correct_index` is dual-written
  // so any reader still on the pre-#592 shim keeps grading correctly during
  // the expand-only window.
  const options = ['A', 'B', 'C', 'D'];
  const correctIndices = [0];
  const { data, error } = await admin
    .from('questions')
    .insert({
      course_id: courseId,
      question: `RLS Test Question ${crypto.randomUUID().slice(0, 8)}`,
      type: 'mcq',
      payload: { options },
      answer_key: { correct_indices: correctIndices, correct_index: correctIndices[0] },
      difficulty: 'medium',
      hidden: false,
      created_by: createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createQuestion: ${error.message}`);
  return data.id;
}

/**
 * Variant used by RLS / migration tests that need to verify the multi-correct
 * pathway end-to-end. Pass any non-empty array of distinct option indices.
 */
export async function createMultiCorrectQuestion(
  admin: SupabaseClient,
  courseId: string,
  correctIndices: number[],
  createdBy?: string
): Promise<string> {
  const options = ['A', 'B', 'C', 'D'];
  const { data, error } = await admin
    .from('questions')
    .insert({
      course_id: courseId,
      question: `RLS Test Multi-Correct Question ${crypto.randomUUID().slice(0, 8)}`,
      type: 'mcq',
      payload: { options },
      answer_key: { correct_indices: correctIndices, correct_index: correctIndices[0] ?? 0 },
      difficulty: 'medium',
      hidden: false,
      created_by: createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createMultiCorrectQuestion: ${error.message}`);
  return data.id;
}

/**
 * Inserts a `type='open'` row directly into `public.questions` — the unified
 * sibling absorbed in #577. Legacy MCQ-only NOT NULL columns get
 * placeholders ([], 0) per migration 20260613000002.
 */
export async function createOpenTypeQuestion(
  admin: SupabaseClient,
  courseId: string,
  createdBy?: string
): Promise<string> {
  const { data, error } = await admin
    .from('questions')
    .insert({
      course_id: courseId,
      question: `RLS Test Open Question ${crypto.randomUUID().slice(0, 8)}`,
      type: 'open',
      payload: {},
      answer_key: {
        model_answer: 'Test model answer',
        rubric: null,
        explanation: null,
      },
      difficulty: 'medium',
      hidden: false,
      created_by: createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOpenTypeQuestion: ${error.message}`);
  return data.id;
}

// `createOpenQuestion` (public.open_questions) was removed with the table
// itself in 20260614000000_contract_question_schema.sql (#582). Use
// `createOpenTypeQuestion` above — open questions are `questions` rows with
// type='open'.

export async function createQuiz(
  admin: SupabaseClient,
  courseId: string,
  isPublished: boolean = true
): Promise<string> {
  const { data, error } = await admin
    .from('quizzes')
    .insert({
      course_id: courseId,
      title: `RLS Test Quiz ${crypto.randomUUID().slice(0, 8)}`,
      is_published: isPublished,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createQuiz: ${error.message}`);
  return data.id;
}

export async function createQuizSession(
  admin: SupabaseClient,
  quizId: string,
  userId: string,
  courseId: string,
  offeringId?: string | null
): Promise<string> {
  // `offering_id` is set here rather than by a follow-up UPDATE because
  // attribution is immutable once the row exists (#1097) — the trigger refuses
  // any later change, which is also how the app writes it: `StudentQuiz`
  // creates the session with its offering already on it.
  const { data, error } = await admin
    .from('quiz_sessions')
    .insert({
      quiz_id: quizId,
      user_id: userId,
      course_id: courseId,
      offering_id: offeringId ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createQuizSession: ${error.message}`);
  return data.id;
}

export async function createQuizAnswer(
  admin: SupabaseClient,
  quizSessionId: string,
  questionId: string,
  userId: string,
  courseId: string,
  offeringId?: string | null
): Promise<string> {
  // Multi-correct (#592): dual-write `selected_answer` (legacy) and
  // `submission.selected_indices` (unified) so the row satisfies the
  // remaining NOT NULL on `selected_answer` while also exercising the new
  // jsonb column.
  const { data, error } = await admin
    .from('quiz_answers')
    .insert({
      session_id: quizSessionId,
      question_id: questionId,
      user_id: userId,
      course_id: courseId,
      offering_id: offeringId ?? null,
      selected_answer: 0,
      submission: { selected_indices: [0] },
      is_correct: false,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createQuizAnswer: ${error.message}`);
  return data.id;
}

export async function createStudySession(
  admin: SupabaseClient,
  courseId: string,
  createdBy?: string
): Promise<string> {
  const { data, error } = await admin
    .from('study_sessions')
    .insert({
      course_id: courseId,
      title: `RLS Test Session ${crypto.randomUUID().slice(0, 8)}`,
      // `is_published` was replaced by `status` in 20260403200000 and narrowed
      // to 'draft' | 'ready' in 20260417000000; the SELECT policy grants
      // students access on `status = 'ready'`.
      status: 'ready',
      created_by: createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudySession: ${error.message}`);
  return data.id;
}

export async function createStudyProgress(
  admin: SupabaseClient,
  studySessionId: string,
  userId: string,
  courseId: string,
  offeringId?: string
): Promise<string> {
  const { data, error } = await admin
    .from('student_study_progress')
    .insert({
      study_session_id: studySessionId,
      user_id: userId,
      course_id: courseId,
      status: 'in_progress',
      offering_id: offeringId ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyProgress: ${error.message}`);
  return data.id;
}

export async function createStudySessionMessage(
  admin: SupabaseClient,
  progressId: string
): Promise<string> {
  const { data, error } = await admin
    .from('study_session_messages')
    .insert({
      progress_id: progressId,
      role: 'user',
      content: 'RLS test message',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudySessionMessage: ${error.message}`);
  return data.id;
}

export async function createOfferingGroup(
  admin: SupabaseClient,
  offeringId: string,
  opts: {
    name?: string;
    isIndividual?: boolean;
    ownerUserId?: string;
    createdBy?: string;
  } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_groups')
    .insert({
      offering_id: offeringId,
      name: opts.name ?? `RLS Test Group ${crypto.randomUUID().slice(0, 8)}`,
      is_individual: opts.isIndividual ?? false,
      owner_user_id: opts.ownerUserId ?? null,
      created_by: opts.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingGroup: ${error.message}`);
  return data.id;
}

export async function addOfferingGroupMember(
  admin: SupabaseClient,
  groupId: string,
  userId: string,
  addedBy?: string
): Promise<void> {
  const { error } = await admin
    .from('offering_group_members')
    .insert({
      group_id: groupId,
      user_id: userId,
      added_by: addedBy ?? null,
    });
  if (error) throw new Error(`addOfferingGroupMember: ${error.message}`);
}

export async function createOfferingQuestion(
  admin: SupabaseClient,
  offeringId: string,
  questionId: string,
  opts: { groupId?: string | null; published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_questions')
    .insert({
      offering_id: offeringId,
      question_id: questionId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingQuestion: ${error.message}`);
  return data.id;
}

// `createOfferingOpenQuestion` (public.offering_open_questions) was removed
// with the table in 20260614000000_contract_question_schema.sql (#582); those
// rows were backfilled into `offering_questions`. Use
// `createOfferingQuestion` above.

export async function createOfferingQuiz(
  admin: SupabaseClient,
  offeringId: string,
  quizId: string,
  opts: { groupId?: string | null; published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_quizzes')
    .insert({
      offering_id: offeringId,
      quiz_id: quizId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingQuiz: ${error.message}`);
  return data.id;
}

export async function createQuizAnalysis(
  admin: SupabaseClient,
  quizId: string,
  offeringId: string,
  opts: { report?: Record<string, unknown>; clusters?: unknown[] } = {}
): Promise<string> {
  // `quiz_analyses` (#837) is not yet in the generated types — cast the table
  // name, same idiom as the jobs/notifications helpers above.
  const { data, error } = await admin
    .from('quiz_analyses' as never)
    .insert({
      quiz_id: quizId,
      offering_id: offeringId,
      report: opts.report ?? { summary: 'RLS test analysis' },
      clusters: opts.clusters ?? [],
    })
    .select('id')
    .single();
  if (error) throw new Error(`createQuizAnalysis: ${error.message}`);
  return (data as { id: string }).id;
}

export async function createOfferingStudySession(
  admin: SupabaseClient,
  offeringId: string,
  studySessionId: string,
  opts: { groupId?: string | null; published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_study_sessions')
    .insert({
      offering_id: offeringId,
      study_session_id: studySessionId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingStudySession: ${error.message}`);
  return data.id;
}

export async function createJob(
  admin: SupabaseClient,
  opts: {
    institutionId: string;
    createdBy: string;
    courseId?: string | null;
    type?: string;
    status?: string;
    params?: Record<string, unknown>;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('jobs' as never)
    .insert({
      type: opts.type ?? 'rls_test_job',
      status: opts.status ?? 'pending',
      params: opts.params ?? {},
      created_by: opts.createdBy,
      institution_id: opts.institutionId,
      course_id: opts.courseId ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createJob: ${error.message}`);
  return (data as { id: string }).id;
}

export async function createJobItem(
  admin: SupabaseClient,
  jobId: string,
  itemKey: string,
  opts: { payload?: Record<string, unknown>; status?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('job_items' as never)
    .insert({
      job_id: jobId,
      item_key: itemKey,
      status: opts.status ?? 'pending',
      payload: opts.payload ?? {},
    })
    .select('id')
    .single();
  if (error) throw new Error(`createJobItem: ${error.message}`);
  return (data as { id: string }).id;
}

export async function createNotification(
  admin: SupabaseClient,
  userId: string,
  opts: {
    jobId?: string | null;
    type?: string;
    title?: string;
    body?: string | null;
  } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('notifications' as never)
    .insert({
      user_id: userId,
      job_id: opts.jobId ?? null,
      type: opts.type ?? 'job_completed',
      title: opts.title ?? `RLS Test Notification ${crypto.randomUUID().slice(0, 8)}`,
      body: opts.body ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createNotification: ${error.message}`);
  return (data as { id: string }).id;
}

export async function createCourseCompetency(
  admin: SupabaseClient,
  courseId: string,
  opts: { title?: string; orderNum?: number } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('course_competencies')
    .insert({
      course_id: courseId,
      title: opts.title ?? `RLS Test Competency ${crypto.randomUUID().slice(0, 8)}`,
      order_num: opts.orderNum ?? 0,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCourseCompetency: ${error.message}`);
  return data.id;
}

export async function createStudentEvaluation(
  admin: SupabaseClient,
  courseId: string,
  userId: string,
  opts: {
    offeringId?: string | null;
    overallAssessment?: string;
    isManual?: boolean;
    instructorFeedback?: string | null;
  } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('student_evaluations')
    .insert({
      course_id: courseId,
      user_id: userId,
      offering_id: opts.offeringId ?? null,
      overall_assessment:
        opts.overallAssessment ?? `RLS test evaluation ${crypto.randomUUID().slice(0, 8)}`,
      strengths: ['RLS strength'],
      weaknesses: ['RLS weakness'],
      recommendations: ['RLS recommendation'],
      is_manual: opts.isManual ?? false,
      instructor_feedback: opts.instructorFeedback ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudentEvaluation: ${error.message}`);
  return data.id;
}

export async function createEvaluationCompetencyScore(
  admin: SupabaseClient,
  evaluationId: string,
  competencyId: string,
  opts: { score?: number | null; rationale?: string | null; isManual?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('evaluation_competency_scores')
    .insert({
      evaluation_id: evaluationId,
      competency_id: competencyId,
      score: opts.score ?? 75,
      rationale: opts.rationale ?? 'RLS test rationale',
      is_manual: opts.isManual ?? false,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createEvaluationCompetencyScore: ${error.message}`);
  return data.id;
}

export async function createEvaluationTimelineCache(
  admin: SupabaseClient,
  courseId: string,
  userId: string,
  opts: { summary?: string; overallTrend?: string; evaluationCount?: number } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('evaluation_timeline_cache')
    .insert({
      course_id: courseId,
      user_id: userId,
      summary: opts.summary ?? `RLS test timeline ${crypto.randomUUID().slice(0, 8)}`,
      overall_trend: opts.overallTrend ?? 'improving',
      evaluation_count: opts.evaluationCount ?? 2,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createEvaluationTimelineCache: ${error.message}`);
  return data.id;
}

export async function createStudentAdminNote(
  admin: SupabaseClient,
  studentUserId: string,
  institutionId: string,
  opts: { body?: string; createdBy?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('student_admin_notes')
    .insert({
      student_user_id: studentUserId,
      institution_id: institutionId,
      body: opts.body ?? `RLS test note ${crypto.randomUUID().slice(0, 8)}`,
      created_by: opts.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudentAdminNote: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Study guides (#977). These tables are not in the generated types yet, so the
// table names are cast — same idiom as `createQuizAnalysis` above.
// ---------------------------------------------------------------------------

export async function createStudyGuide(
  admin: SupabaseClient,
  courseId: string,
  opts: {
    title?: string;
    brief?: string;
    materialId?: string | null;
    createdBy?: string;
  } = {}
): Promise<string> {
  // No `status`: study guides have no draft/ready gate. Assignment to a
  // section is the only thing that puts one in front of a student, so the
  // column was dropped in 20260729100000.
  const { data, error } = await admin
    .from('study_guides' as never)
    .insert({
      course_id: courseId,
      material_id: opts.materialId ?? null,
      title: opts.title ?? `RLS Test Study Guide ${crypto.randomUUID().slice(0, 8)}`,
      brief: opts.brief ?? 'RLS test brief',
      created_by: opts.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyGuide: ${error.message}`);
  return (data as { id: string }).id;
}

export async function createStudyGuidePiece(
  admin: SupabaseClient,
  studyGuideId: string,
  position: number,
  opts: { title?: string; theoryHtml?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('study_guide_pieces' as never)
    .insert({
      study_guide_id: studyGuideId,
      position,
      title: opts.title ?? `RLS Test Piece ${position}`,
      theory_html: opts.theoryHtml ?? '<p>RLS test theory</p>',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyGuidePiece: ${error.message}`);
  return (data as { id: string }).id;
}

export async function addStudyGuidePieceQuestion(
  admin: SupabaseClient,
  pieceId: string,
  questionId: string,
  position = 0
): Promise<void> {
  const { error } = await admin
    .from('study_guide_piece_questions' as never)
    .insert({ piece_id: pieceId, question_id: questionId, position });
  if (error) throw new Error(`addStudyGuidePieceQuestion: ${error.message}`);
}

export async function createOfferingStudyGuide(
  admin: SupabaseClient,
  offeringId: string,
  studyGuideId: string,
  opts: { groupId?: string | null; published?: boolean; dueDate?: string | null } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_study_guides' as never)
    .insert({
      offering_id: offeringId,
      study_guide_id: studyGuideId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
      due_date: opts.dueDate ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingStudyGuide: ${error.message}`);
  return (data as { id: string }).id;
}

export async function createStudyGuideAnswer(
  admin: SupabaseClient,
  opts: {
    userId: string;
    studyGuideId: string;
    offeringId: string;
    pieceId: string;
    questionId: string;
    submission?: Record<string, unknown>;
    isCorrect?: boolean | null;
  }
): Promise<string> {
  // The answer tuple trigger requires (piece_id, question_id) to be a real
  // piece-question pair, so make sure the link exists before inserting.
  const { error: linkError } = await admin
    .from('study_guide_piece_questions' as never)
    .upsert(
      { piece_id: opts.pieceId, question_id: opts.questionId, position: 0 },
      { onConflict: 'piece_id,question_id' }
    );
  if (linkError) throw new Error(`createStudyGuideAnswer (link): ${linkError.message}`);

  const { data, error } = await admin
    .from('study_guide_answers' as never)
    .insert({
      user_id: opts.userId,
      study_guide_id: opts.studyGuideId,
      offering_id: opts.offeringId,
      piece_id: opts.pieceId,
      question_id: opts.questionId,
      submission: opts.submission ?? { selected_indices: [0] },
      is_correct: opts.isCorrect ?? true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyGuideAnswer: ${error.message}`);
  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Open-question student work. `open_question_id` points at `public.questions`
// (the `open_questions` table itself was absorbed in #582), so build the parent
// row with `createOpenTypeQuestion` above.
// ---------------------------------------------------------------------------

export async function createOpenQuestionGrade(
  admin: SupabaseClient,
  opts: {
    openQuestionId: string;
    userId: string;
    courseId: string;
    offeringId?: string | null;
    grade?: number;
    feedback?: string;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('open_question_grades')
    .insert({
      open_question_id: opts.openQuestionId,
      user_id: opts.userId,
      course_id: opts.courseId,
      offering_id: opts.offeringId ?? null,
      grade: opts.grade ?? 80,
      feedback: opts.feedback ?? 'RLS test feedback',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOpenQuestionGrade: ${error.message}`);
  return data.id;
}

export async function createOpenQuestionProgress(
  admin: SupabaseClient,
  opts: {
    userId: string;
    openQuestionId: string;
    courseId: string;
    offeringId?: string | null;
    status?: string;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('open_question_progress')
    .insert({
      user_id: opts.userId,
      open_question_id: opts.openQuestionId,
      course_id: opts.courseId,
      offering_id: opts.offeringId ?? null,
      status: opts.status ?? 'in_progress',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOpenQuestionProgress: ${error.message}`);
  return data.id;
}

export async function createOpenQuestionChat(
  admin: SupabaseClient,
  opts: {
    openQuestionId: string;
    userId: string;
    courseId: string;
    role?: 'user' | 'assistant' | 'instructor' | 'system';
    content?: string;
    senderUserId?: string | null;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('open_question_chats')
    .insert({
      open_question_id: opts.openQuestionId,
      user_id: opts.userId,
      course_id: opts.courseId,
      role: opts.role ?? 'user',
      content: opts.content ?? 'RLS test chat message',
      sender_user_id: opts.senderUserId ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOpenQuestionChat: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// The unified chat tables (20260902100000). Both tutoring surfaces — the study
// tutor and the open-question thread — are one `chat_sessions` row plus its
// `chat_messages`, and these are the tables the app actually writes.
// `createStudyProgress` / `createOpenQuestionChat` above still write the legacy
// pair, which nothing but `export-data` reads any more.
// ---------------------------------------------------------------------------

export async function createChatSession(
  admin: SupabaseClient,
  opts: {
    userId: string;
    courseId: string;
    /**
     * The section the work belongs to.
     *
     * Left NULL, the row is "unattributed", and the section-scoped write
     * policies admit only an unrestricted instructor — see
     * `chat-sessions-section-scope.test.ts`, which is about exactly that.
     */
    offeringId?: string | null;
    studySessionId?: string | null;
    openQuestionId?: string | null;
    status?: 'in_progress' | 'paused' | 'completed';
  }
): Promise<string> {
  const { data, error } = await admin
    .from('chat_sessions')
    .insert({
      user_id: opts.userId,
      course_id: opts.courseId,
      offering_id: opts.offeringId ?? null,
      study_session_id: opts.studySessionId ?? null,
      open_question_id: opts.openQuestionId ?? null,
      status: opts.status ?? 'in_progress',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createChatSession: ${error.message}`);
  return data.id;
}

export async function createChatMessage(
  admin: SupabaseClient,
  opts: {
    sessionId: string;
    role?: 'user' | 'assistant' | 'instructor' | 'moderation';
    content?: string;
    senderUserId?: string | null;
    flaggedOffensive?: boolean;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('chat_messages')
    .insert({
      session_id: opts.sessionId,
      role: opts.role ?? 'user',
      content: opts.content ?? 'RLS test chat message',
      sender_user_id: opts.senderUserId ?? null,
      flagged_offensive: opts.flaggedOffensive ?? false,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createChatMessage: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Printable tests and OCR-graded paper tests. No frontend or edge function
// reads these tables today (only `export-data` touches `graded_tests`), but
// RLS is enabled on all five and PostgREST exposes them, so the policies are
// still reachable by any authenticated caller.
// ---------------------------------------------------------------------------

export async function createTest(
  admin: SupabaseClient,
  courseId: string,
  opts: { title?: string; isPublished?: boolean; createdBy?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('tests')
    .insert({
      course_id: courseId,
      title: opts.title ?? `RLS Test Test ${crypto.randomUUID().slice(0, 8)}`,
      is_published: opts.isPublished ?? true,
      created_by: opts.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createTest: ${error.message}`);
  return data.id;
}

export async function addTestQuestion(
  admin: SupabaseClient,
  testId: string,
  questionId: string,
  opts: { orderNum?: number; points?: number } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('test_questions')
    .insert({
      test_id: testId,
      question_id: questionId,
      order_num: opts.orderNum ?? 0,
      points: opts.points ?? 1,
    })
    .select('id')
    .single();
  if (error) throw new Error(`addTestQuestion: ${error.message}`);
  return data.id;
}

export async function createOfferingTest(
  admin: SupabaseClient,
  offeringId: string,
  testId: string,
  opts: { groupId?: string | null; published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_tests')
    .insert({
      offering_id: offeringId,
      test_id: testId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingTest: ${error.message}`);
  return data.id;
}

export async function createGradedTest(
  admin: SupabaseClient,
  courseId: string,
  opts: { studentId?: string | null; title?: string; status?: string; answerKey?: string | null } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('graded_tests')
    .insert({
      course_id: courseId,
      student_id: opts.studentId ?? null,
      title: opts.title ?? `RLS Graded Test ${crypto.randomUUID().slice(0, 8)}`,
      status: opts.status ?? 'uploaded',
      original_file_url: 'https://example.com/rls-test-scan.pdf',
      original_file_name: 'rls-test-scan.pdf',
      file_type: 'pdf',
      answer_key: opts.answerKey ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createGradedTest: ${error.message}`);
  return data.id;
}

export async function createGradedTestQuestion(
  admin: SupabaseClient,
  gradedTestId: string,
  opts: { questionNumber?: number; expectedAnswer?: string; studentAnswer?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('graded_test_questions')
    .insert({
      graded_test_id: gradedTestId,
      question_number: opts.questionNumber ?? 1,
      question_text: 'RLS test question text',
      student_answer: opts.studentAnswer ?? 'RLS student answer',
      expected_answer: opts.expectedAnswer ?? 'RLS expected answer',
      max_points: 10,
      awarded_points: 7,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createGradedTestQuestion: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Flashcards: per-user spaced-repetition state, saved practice sessions, and
// the per-chapter content an instructor publishes to a section.
// ---------------------------------------------------------------------------

export async function createFlashcardReview(
  admin: SupabaseClient,
  opts: {
    userId: string;
    chapterId: string;
    courseId: string;
    flashcardIndex?: number;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('flashcard_reviews')
    .insert({
      user_id: opts.userId,
      chapter_id: opts.chapterId,
      course_id: opts.courseId,
      flashcard_index: opts.flashcardIndex ?? 0,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createFlashcardReview: ${error.message}`);
  return data.id;
}

export async function createFlashcardSession(
  admin: SupabaseClient,
  opts: {
    userId: string;
    courseId: string;
    chapterIds: string[];
    name?: string;
    offeringId?: string | null;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('flashcard_sessions')
    .insert({
      user_id: opts.userId,
      course_id: opts.courseId,
      chapter_ids: opts.chapterIds,
      name: opts.name ?? `RLS Flashcard Session ${crypto.randomUUID().slice(0, 8)}`,
      offering_id: opts.offeringId ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createFlashcardSession: ${error.message}`);
  return data.id;
}

export async function createOfferingChapterFlashcards(
  admin: SupabaseClient,
  offeringId: string,
  chapterId: string,
  opts: { groupId?: string | null; published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_chapter_flashcards')
    .insert({
      offering_id: offeringId,
      chapter_id: chapterId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingChapterFlashcards: ${error.message}`);
  return data.id;
}

export async function createOfferingChapterCheatsheet(
  admin: SupabaseClient,
  offeringId: string,
  chapterId: string,
  opts: { groupId?: string | null; published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_chapter_cheatsheets')
    .insert({
      offering_id: offeringId,
      chapter_id: chapterId,
      group_id: opts.groupId ?? null,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingChapterCheatsheet: ${error.message}`);
  return data.id;
}

export async function createOfferingFlashcardSession(
  admin: SupabaseClient,
  offeringId: string,
  flashcardSessionId: string,
  opts: { published?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('offering_flashcard_sessions')
    .insert({
      offering_id: offeringId,
      flashcard_session_id: flashcardSessionId,
      published_at: opts.published === false ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`createOfferingFlashcardSession: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Study-session scaffolding not already covered above: the per-class chapter
// completion ledger and the competency tags on a study session.
// ---------------------------------------------------------------------------

export async function createCourseChapterProgress(
  admin: SupabaseClient,
  opts: {
    courseId: string;
    chapterId: string;
    classId?: string | null;
    isComplete?: boolean;
    completedBy?: string | null;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('course_chapter_progress')
    .insert({
      course_id: opts.courseId,
      chapter_id: opts.chapterId,
      class_id: opts.classId ?? null,
      is_complete: opts.isComplete ?? true,
      completed_by: opts.completedBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCourseChapterProgress: ${error.message}`);
  return data.id;
}

export async function addStudySessionCompetency(
  admin: SupabaseClient,
  studySessionId: string,
  competencyId: string
): Promise<string> {
  const { data, error } = await admin
    .from('study_session_competencies')
    .insert({ study_session_id: studySessionId, competency_id: competencyId })
    .select('id')
    .single();
  if (error) throw new Error(`addStudySessionCompetency: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Tutor session state: the socratic open-question tutor, the study-guide
// tutor, the course copilot, and textbook chat.
// ---------------------------------------------------------------------------

export async function createSocraticSessionState(
  admin: SupabaseClient,
  opts: { userId: string; openQuestionId: string; courseId: string }
): Promise<string> {
  const { data, error } = await admin
    .from('socratic_session_state')
    .insert({
      user_id: opts.userId,
      open_question_id: opts.openQuestionId,
      course_id: opts.courseId,
      current_state: { phase: 'rls-test' },
    })
    .select('id')
    .single();
  if (error) throw new Error(`createSocraticSessionState: ${error.message}`);
  return data.id;
}

export async function createSocraticStateHistory(
  admin: SupabaseClient,
  sessionStateId: string
): Promise<string> {
  const { data, error } = await admin
    .from('socratic_state_history')
    .insert({
      session_state_id: sessionStateId,
      state_after: { phase: 'rls-test-after' },
      transition_type: 'rls_test',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createSocraticStateHistory: ${error.message}`);
  return data.id;
}

export async function createStudyTutorSessionState(
  admin: SupabaseClient,
  opts: { userId: string; progressId: string; courseId: string }
): Promise<string> {
  const { data, error } = await admin
    .from('study_tutor_session_state')
    .insert({
      user_id: opts.userId,
      progress_id: opts.progressId,
      course_id: opts.courseId,
      current_state: { phase: 'rls-test' },
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyTutorSessionState: ${error.message}`);
  return data.id;
}

export async function createStudyTutorStateHistory(
  admin: SupabaseClient,
  sessionStateId: string
): Promise<string> {
  const { data, error } = await admin
    .from('study_tutor_state_history')
    .insert({
      session_state_id: sessionStateId,
      state_after: { phase: 'rls-test-after' },
      transition_type: 'rls_test',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyTutorStateHistory: ${error.message}`);
  return data.id;
}

export async function createCopilotSession(
  admin: SupabaseClient,
  opts: { userId: string; courseId: string; name?: string }
): Promise<string> {
  const { data, error } = await admin
    .from('copilot_sessions')
    .insert({
      user_id: opts.userId,
      course_id: opts.courseId,
      name: opts.name ?? `RLS Copilot ${crypto.randomUUID().slice(0, 8)}`,
      messages: [],
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCopilotSession: ${error.message}`);
  return data.id;
}

export async function createTextbookChatMessage(
  admin: SupabaseClient,
  opts: {
    userId: string;
    courseId: string;
    materialId: string;
    role?: string;
    content?: string;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('textbook_chat_messages')
    .insert({
      user_id: opts.userId,
      course_id: opts.courseId,
      material_id: opts.materialId,
      role: opts.role ?? 'user',
      content: opts.content ?? 'RLS test textbook question',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createTextbookChatMessage: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Announcements, the per-student admin notification feed, and the moderation
// queue.
// ---------------------------------------------------------------------------

export async function createClassAnnouncement(
  admin: SupabaseClient,
  courseId: string,
  opts: { authorId?: string | null; title?: string; body?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('class_announcements')
    .insert({
      course_id: courseId,
      author_id: opts.authorId ?? null,
      title: opts.title ?? `RLS Announcement ${crypto.randomUUID().slice(0, 8)}`,
      body: opts.body ?? 'RLS test announcement body',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createClassAnnouncement: ${error.message}`);
  return data.id;
}

export async function targetAnnouncementAtOffering(
  admin: SupabaseClient,
  announcementId: string,
  offeringId: string
): Promise<void> {
  const { error } = await admin
    .from('announcement_offerings')
    .insert({ announcement_id: announcementId, offering_id: offeringId });
  if (error) throw new Error(`targetAnnouncementAtOffering: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Instructor-distributed course notes (20260831120000). Same shape as
// announcements: the row carries a course_id, `course_note_offerings` decides
// which sections receive it, and an untargeted note is a draft.
// ---------------------------------------------------------------------------

export async function createCourseNote(
  admin: SupabaseClient,
  courseId: string,
  opts: {
    authorId?: string | null;
    title?: string;
    filePath?: string;
    fileName?: string;
  } = {}
): Promise<{ id: string; filePath: string }> {
  const filePath =
    opts.filePath ?? `${courseId}/${crypto.randomUUID()}-rls-note.pdf`;
  const { data, error } = await admin
    .from('course_notes')
    .insert({
      course_id: courseId,
      author_id: opts.authorId ?? null,
      title: opts.title ?? `RLS Note ${crypto.randomUUID().slice(0, 8)}`,
      file_path: filePath,
      file_name: opts.fileName ?? 'rls-note.pdf',
      mime_type: 'application/pdf',
      file_size: 1024,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createCourseNote: ${error.message}`);
  return { id: data.id, filePath };
}

export async function targetNoteAtOffering(
  admin: SupabaseClient,
  noteId: string,
  offeringId: string
): Promise<void> {
  const { error } = await admin
    .from('course_note_offerings')
    .insert({ note_id: noteId, offering_id: offeringId });
  if (error) throw new Error(`targetNoteAtOffering: ${error.message}`);
}

export async function markAnnouncementRead(
  admin: SupabaseClient,
  announcementId: string,
  userId: string
): Promise<void> {
  const { error } = await admin
    .from('announcement_reads')
    .insert({ announcement_id: announcementId, user_id: userId });
  if (error) throw new Error(`markAnnouncementRead: ${error.message}`);
}

export async function createAdminNotification(
  admin: SupabaseClient,
  opts: { courseId: string; studentId: string; title?: string; message?: string }
): Promise<string> {
  const { data, error } = await admin
    .from('admin_notifications')
    .insert({
      course_id: opts.courseId,
      student_id: opts.studentId,
      title: opts.title ?? `RLS Admin Notification ${crypto.randomUUID().slice(0, 8)}`,
      message: opts.message ?? 'RLS test notification message',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createAdminNotification: ${error.message}`);
  return data.id;
}

export async function createFlaggedContent(
  admin: SupabaseClient,
  opts: { description?: string; data?: Record<string, unknown> } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('flagged_content')
    .insert({
      description: opts.description ?? `RLS flagged ${crypto.randomUUID().slice(0, 8)}`,
      data: opts.data ?? { reason: 'rls test' },
    })
    .select('id')
    .single();
  if (error) throw new Error(`createFlaggedContent: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Remaining #1095 tables: quiz internals, invitation course scoping, the
// competency↔chapter map, exercise PDFs, grade-level assignment, the admin
// note audit trail, and the AI rate-limit ledger.
// ---------------------------------------------------------------------------

export async function addQuizQuestion(
  admin: SupabaseClient,
  quizId: string,
  questionId: string,
  orderNum = 0
): Promise<string> {
  const { data, error } = await admin
    .from('quiz_questions')
    .insert({ quiz_id: quizId, question_id: questionId, order_num: orderNum })
    .select('id')
    .single();
  if (error) throw new Error(`addQuizQuestion: ${error.message}`);
  return data.id;
}

export async function createQuizSessionQuestion(
  admin: SupabaseClient,
  sessionId: string,
  questionId: string,
  orderNum = 0
): Promise<string> {
  const { data, error } = await admin
    .from('quiz_session_questions')
    .insert({
      session_id: sessionId,
      question_id: questionId,
      order_num: orderNum,
      question_snapshot: { question: 'RLS snapshot', options: ['A', 'B'] },
    })
    .select('id')
    .single();
  if (error) throw new Error(`createQuizSessionQuestion: ${error.message}`);
  return data.id;
}

export async function createInvitation(
  admin: SupabaseClient,
  institutionId: string,
  opts: { email?: string; role?: string; invitedBy?: string | null } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('invitations')
    .insert({
      institution_id: institutionId,
      email: opts.email ?? `rls-invite-${crypto.randomUUID().slice(0, 8)}@test.local`,
      role: opts.role ?? 'student',
      invited_by: opts.invitedBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createInvitation: ${error.message}`);
  return data.id;
}

export async function addInvitationCourse(
  admin: SupabaseClient,
  invitationId: string,
  courseId: string
): Promise<void> {
  const { error } = await admin
    .from('invitation_courses')
    .insert({ invitation_id: invitationId, course_id: courseId });
  if (error) throw new Error(`addInvitationCourse: ${error.message}`);
}

export async function addCompetencyChapter(
  admin: SupabaseClient,
  competencyId: string,
  chapterId: string
): Promise<string> {
  const { data, error } = await admin
    .from('competency_chapters')
    .insert({ competency_id: competencyId, chapter_id: chapterId })
    .select('id')
    .single();
  if (error) throw new Error(`addCompetencyChapter: ${error.message}`);
  return data.id;
}

export async function createExercisePdf(
  admin: SupabaseClient,
  courseId: string,
  opts: { title?: string; uploadedBy?: string | null } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('course_exercise_pdfs')
    .insert({
      course_id: courseId,
      title: opts.title ?? `RLS Exercise PDF ${crypto.randomUUID().slice(0, 8)}`,
      file_name: 'rls-exercises.pdf',
      file_url: 'https://example.com/rls-exercises.pdf',
      uploaded_by: opts.uploadedBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createExercisePdf: ${error.message}`);
  return data.id;
}

export async function assignUserGradeLevel(
  admin: SupabaseClient,
  userInstitutionId: string,
  gradeLevelId: string
): Promise<string> {
  const { data, error } = await admin
    .from('user_institution_grades')
    .insert({ user_institution_id: userInstitutionId, grade_level_id: gradeLevelId })
    .select('id')
    .single();
  if (error) throw new Error(`assignUserGradeLevel: ${error.message}`);
  return data.id;
}

export async function createRateLimitEvent(
  admin: SupabaseClient,
  opts: { functionName?: string; eventType?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('ai_rate_limit_events')
    .insert({
      event_type: opts.eventType ?? 'throttled',
      function_name: opts.functionName ?? 'rls-test-function',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createRateLimitEvent: ${error.message}`);
  return data.id;
}
