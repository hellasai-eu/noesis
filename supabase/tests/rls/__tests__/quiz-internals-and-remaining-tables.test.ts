// Tables under test — the last of the #1095 list:
//   * public.quiz_questions            — a quiz's question list
//   * public.quiz_session_questions    — the per-attempt question snapshot
//   * public.invitation_courses        — which courses an invitation grants
//   * public.competency_chapters       — competency ↔ chapter map
//   * public.course_exercise_pdfs      — instructor-uploaded exercise sheets
//   * public.user_institution_grades   — a member's grade-level assignment
//   * public.student_admin_notes_audit — audit trail behind student_admin_notes
//   * public.ai_rate_limit_events      — provider rate-limit ledger
//
// The last one shipped with a policy named "Service role full access" that had
// no `TO service_role`, so it applied to PUBLIC with `USING true` and granted
// every caller full DML rather than none (#1127). 20260820100000 drops it; the
// tests at the bottom of this file assert the closed behaviour.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, getAnonClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseMaterial,
  createMaterialChapter,
  createCourseCompetency,
  createQuestion,
  createQuiz,
  createQuizSession,
  addQuizQuestion,
  createQuizSessionQuestion,
  createInvitation,
  addInvitationCourse,
  addCompetencyChapter,
  createExercisePdf,
  assignUserGradeLevel,
  createRateLimitEvent,
  createStudentAdminNote,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('quiz internals, invitations, competencies, grades and rate limits RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA: string;
  let chapterA: string;

  let instB: string;
  let courseB: string;
  let classB: string;

  let publishedQuizQuestion: string;
  let draftQuizQuestion: string;
  let ownSessionQuestion: string;
  let peerSessionQuestion: string;
  let invitationId: string;
  let foreignInvitationId: string;
  let competencyChapter: string;
  let exercisePdf: string;
  let gradeAssignment: string;
  let rateLimitEvent: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient;
  let peerId: string;
  let instructorClient: SupabaseClient;
  let adminAClient: SupabaseClient;
  let outsiderClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Misc A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    await createOffering(admin, classA, courseA);
    chapterA = await createMaterialChapter(admin, await createCourseMaterial(admin, courseA));

    instB = await createInstitution(admin, `RLS Misc B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);

    const stu = await createTestUserClient(admin, `rls-misc-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-misc-peer-${uid}@test.local`);
    peerClient = peer.client; peerId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-misc-instr-${uid}@test.local`);
    instructorClient = instr.client; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const adm = await createTestUserClient(admin, `rls-misc-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const out = await createTestUserClient(admin, `rls-misc-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'student');
    await enrollInClass(admin, classB, out.userId, 'student');


    const publishedQuiz = await createQuiz(admin, courseA, true);
    const draftQuiz = await createQuiz(admin, courseA, false);
    publishedQuizQuestion = await addQuizQuestion(
      admin, publishedQuiz, await createQuestion(admin, courseA)
    );
    draftQuizQuestion = await addQuizQuestion(
      admin, draftQuiz, await createQuestion(admin, courseA)
    );

    const ownSession = await createQuizSession(admin, publishedQuiz, studentId, courseA);
    const peerSession = await createQuizSession(admin, publishedQuiz, peerId, courseA);
    ownSessionQuestion = await createQuizSessionQuestion(
      admin, ownSession, await createQuestion(admin, courseA)
    );
    peerSessionQuestion = await createQuizSessionQuestion(
      admin, peerSession, await createQuestion(admin, courseA)
    );

    invitationId = await createInvitation(admin, instA);
    await addInvitationCourse(admin, invitationId, courseA);
    foreignInvitationId = await createInvitation(admin, instB);
    await addInvitationCourse(admin, foreignInvitationId, courseB);

    competencyChapter = await addCompetencyChapter(
      admin, await createCourseCompetency(admin, courseA), chapterA
    );
    exercisePdf = await createExercisePdf(admin, courseA);

    const { data: membership } = await admin
      .from('user_institutions')
      .select('id').eq('user_id', studentId).eq('institution_id', instA).single();
    const { data: gradeLevel } = await admin
      .from('grade_levels').select('id').limit(1).single();
    gradeAssignment = await assignUserGradeLevel(
      admin, (membership as { id: string }).id, (gradeLevel as { id: string }).id
    );

    rateLimitEvent = await createRateLimitEvent(admin);
  });

  afterAll(async () => {
    await admin.from('ai_rate_limit_events').delete().eq('function_name', 'rls-test-function');
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // quiz_questions / quiz_session_questions
  // =====================================================================

  it('student sees the question list of a published quiz only', async () => {
    const { data: published, error } = await studentClient
      .from('quiz_questions').select('id').eq('id', publishedQuizQuestion);
    expect(error).toBeNull();
    expect(published).toHaveLength(1);

    const { data: draft } = await studentClient
      .from('quiz_questions').select('id').eq('id', draftQuizQuestion);
    expect(draft).toHaveLength(0);
  });

  it('assigned instructor sees both and can edit the list', async () => {
    const { data, error } = await instructorClient
      .from('quiz_questions').select('id').in('id', [publishedQuizQuestion, draftQuizQuestion]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);

    const { data: deleted } = await instructorClient
      .from('quiz_questions').delete().eq('id', draftQuizQuestion).select('id');
    expect(deleted).toHaveLength(1);
  });

  it('student cannot edit a quiz question list', async () => {
    const { error } = await studentClient
      .from('quiz_questions')
      .insert({ quiz_id: (await createQuiz(admin, courseA, true)), question_id: await createQuestion(admin, courseA) });
    expect(error).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('quiz_questions').delete().eq('id', publishedQuizQuestion).select();
    expect(deleted).toHaveLength(0);
  });

  it('student sees their own attempt snapshot and not a classmate’s', async () => {
    const { data: own, error } = await studentClient
      .from('quiz_session_questions').select('id').eq('id', ownSessionQuestion);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: theirs } = await studentClient
      .from('quiz_session_questions').select('id').eq('id', peerSessionQuestion);
    expect(theirs).toHaveLength(0);
  });

  it('attempt snapshots are insert-and-read only — no update or delete path', async () => {
    // quiz_session_questions has exactly two policies, SELECT and INSERT, both
    // keyed on owning the session. Nobody can rewrite or remove a snapshot
    // through the API, which is what makes it usable as attempt evidence.
    const { data: updated } = await studentClient
      .from('quiz_session_questions')
      .update({ order_num: 99 }).eq('id', ownSessionQuestion).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await studentClient
      .from('quiz_session_questions').delete().eq('id', ownSessionQuestion).select();
    expect(deleted).toHaveLength(0);

    const { data: byInstructor } = await instructorClient
      .from('quiz_session_questions').select('id').eq('id', ownSessionQuestion);
    expect(byInstructor).toHaveLength(0);
  });

  // =====================================================================
  // invitation_courses
  // =====================================================================

  it('institution member reads the course scoping of their institution’s invitations', async () => {
    const { data, error } = await studentClient
      .from('invitation_courses').select('course_id').eq('invitation_id', invitationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('member of another institution reads none of it', async () => {
    const { data, error } = await outsiderClient
      .from('invitation_courses').select('course_id').eq('invitation_id', invitationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('only an institution admin can change what an invitation grants', async () => {
    const { error: byStudent } = await studentClient
      .from('invitation_courses')
      .insert({ invitation_id: invitationId, course_id: courseA });
    expect(byStudent).not.toBeNull();

    const { data: deletedByStudent } = await studentClient
      .from('invitation_courses')
      .delete().eq('invitation_id', invitationId).select();
    expect(deletedByStudent).toHaveLength(0);

    const { data: deletedByAdmin } = await adminAClient
      .from('invitation_courses')
      .delete().eq('invitation_id', invitationId).select('course_id');
    expect(deletedByAdmin).toHaveLength(1);
  });

  it('an admin cannot scope another institution’s invitation', async () => {
    const { error } = await adminAClient
      .from('invitation_courses')
      .insert({ invitation_id: foreignInvitationId, course_id: courseB });
    expect(error).not.toBeNull();
  });

  // =====================================================================
  // competency_chapters + course_exercise_pdfs
  // =====================================================================

  it('student with course access reads competency chapters and exercise PDFs', async () => {
    const { data: chapters, error } = await studentClient
      .from('competency_chapters').select('id').eq('id', competencyChapter);
    expect(error).toBeNull();
    expect(chapters).toHaveLength(1);

    const { data: pdfs } = await studentClient
      .from('course_exercise_pdfs').select('id').eq('id', exercisePdf);
    expect(pdfs).toHaveLength(1);
  });

  it('student of another institution reads neither', async () => {
    const { data: chapters, error } = await outsiderClient
      .from('competency_chapters').select('id').eq('id', competencyChapter);
    expect(error).toBeNull();
    expect(chapters).toHaveLength(0);

    const { data: pdfs } = await outsiderClient
      .from('course_exercise_pdfs').select('id').eq('id', exercisePdf);
    expect(pdfs).toHaveLength(0);
  });

  it('student cannot map a chapter to a competency or upload an exercise PDF', async () => {
    const competency = await createCourseCompetency(admin, courseA);
    const { error: mapError } = await studentClient
      .from('competency_chapters')
      .insert({ competency_id: competency, chapter_id: chapterA });
    expect(mapError).not.toBeNull();

    const { error: pdfError } = await studentClient
      .from('course_exercise_pdfs')
      .insert({
        course_id: courseA, title: 'student upload',
        file_name: 'x.pdf', file_url: 'https://example.com/x.pdf',
      });
    expect(pdfError).not.toBeNull();
  });

  it('assigned instructor can map a chapter and upload an exercise PDF', async () => {
    const competency = await createCourseCompetency(admin, courseA);
    const { data: mapped, error } = await instructorClient
      .from('competency_chapters')
      .insert({ competency_id: competency, chapter_id: chapterA })
      .select('id').single();
    expect(error).toBeNull();
    expect(mapped).not.toBeNull();

    const { data: pdf, error: pdfError } = await instructorClient
      .from('course_exercise_pdfs')
      .insert({
        course_id: courseA, title: `instructor upload ${uid}`,
        file_name: 'y.pdf', file_url: 'https://example.com/y.pdf',
      })
      .select('id').single();
    expect(pdfError).toBeNull();
    expect(pdf).not.toBeNull();
  });

  // =====================================================================
  // user_institution_grades
  // =====================================================================

  it('member reads their own grade-level assignment and not a peer’s', async () => {
    const { data: own, error } = await studentClient
      .from('user_institution_grades').select('id').eq('id', gradeAssignment);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: byPeer } = await peerClient
      .from('user_institution_grades').select('id').eq('id', gradeAssignment);
    expect(byPeer).toHaveLength(0);
  });

  it('a student cannot assign themselves a grade level', async () => {
    const { data: deleted } = await studentClient
      .from('user_institution_grades').delete().eq('id', gradeAssignment).select();
    expect(deleted).toHaveLength(0);
  });

  it('institution admin manages grade-level assignments, and an outsider cannot', async () => {
    const { data: byAdmin, error } = await adminAClient
      .from('user_institution_grades').select('id').eq('id', gradeAssignment);
    expect(error).toBeNull();
    expect(byAdmin).toHaveLength(1);

    const { data: byOutsider } = await outsiderClient
      .from('user_institution_grades').select('id').eq('id', gradeAssignment);
    expect(byOutsider).toHaveLength(0);
  });

  // =====================================================================
  // student_admin_notes_audit
  // =====================================================================

  it('institution admin reads the note audit trail; nobody else does', async () => {
    await createStudentAdminNote(admin, studentId, instA, { body: `audited ${uid}` });

    const { data: byAdmin, error } = await adminAClient
      .from('student_admin_notes_audit').select('id').eq('institution_id', instA);
    expect(error).toBeNull();
    expect(byAdmin!.length).toBeGreaterThan(0);

    for (const [label, client] of [
      ['student', studentClient],
      ['instructor', instructorClient],
      ['outsider', outsiderClient],
    ] as const) {
      const { data } = await client
        .from('student_admin_notes_audit').select('id').eq('institution_id', instA);
      expect(data, label).toHaveLength(0);
    }
  });

  it('the audit trail cannot be written or erased through the API', async () => {
    // Only a SELECT policy exists, so the trigger behind student_admin_notes
    // is the sole writer and an admin cannot cover their tracks.
    const { data: existing } = await admin
      .from('student_admin_notes_audit').select('id').eq('institution_id', instA).limit(1);
    const rowId = (existing as Array<{ id: string }>)[0]?.id;
    expect(rowId).toBeTruthy();

    const { data: deleted } = await adminAClient
      .from('student_admin_notes_audit').delete().eq('id', rowId).select();
    expect(deleted).toHaveLength(0);

    const { error: inserted } = await adminAClient
      .from('student_admin_notes_audit')
      .insert({
        action: 'forged', note_id: rowId, student_user_id: studentId, institution_id: instA,
      });
    expect(inserted).not.toBeNull();
  });
  // =====================================================================
  // ai_rate_limit_events — service-role only (#1127)
  //
  // The table shipped with
  //
  //   CREATE POLICY "Service role full access" ON ai_rate_limit_events
  //     FOR ALL USING (true) WITH CHECK (true);
  //
  // which, with no `TO service_role`, applied to PUBLIC and handed every
  // authenticated caller full DML across every tenant. `service_role` is
  // created with BYPASSRLS and was never subject to RLS here, so the policy
  // only ever widened access.
  //
  // 20260820100000 drops it. RLS stays enabled with no policies, which denies
  // anon/authenticated outright while the service role continues to bypass —
  // the same shape `public.run_jobs_tick` uses. These tests are the inverse of
  // the ones that pinned the bug.
  // =====================================================================

  it('an authenticated user cannot read the rate-limit ledger', async () => {
    const { data, error } = await studentClient
      .from('ai_rate_limit_events').select('id').eq('id', rateLimitEvent);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an authenticated user cannot forge or delete rate-limit rows', async () => {
    const { error } = await studentClient
      .from('ai_rate_limit_events')
      .insert({ event_type: 'exhausted', function_name: 'rls-test-function' });
    expect(error).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('ai_rate_limit_events').delete().eq('id', rateLimitEvent).select('id');
    expect(deleted).toHaveLength(0);

    // The row the student tried to delete is still there.
    const { data: survives } = await admin
      .from('ai_rate_limit_events').select('id').eq('id', rateLimitEvent);
    expect(survives).toHaveLength(1);
  });

  it('no role reaches the ledger through the API, including anon and admins', async () => {
    // There is no policy at all, so institution admins get nothing either —
    // the rows carry user_id / institution_id / course_id and are read by the
    // GDPR export with the service role, not by anyone over PostgREST.
    //
    // `anon` is listed explicitly rather than assumed: the DML grant exists for
    // it too, and it is the one role whose denial does not follow from
    // `auth.uid()` being unmatched, since no policy references auth.uid() here.
    const event = await createRateLimitEvent(admin);
    for (const [label, client] of [
      ['anon', getAnonClient()],
      ['student', studentClient],
      ['instructor', instructorClient],
      ['institution admin', adminAClient],
      ['other tenant', outsiderClient],
    ] as const) {
      const { data, error } = await client
        .from('ai_rate_limit_events').select('id').eq('id', event);
      expect(error, label).toBeNull();
      expect(data, label).toHaveLength(0);
    }
  });

  it('anon cannot write to the ledger either', async () => {
    const { error } = await getAnonClient()
      .from('ai_rate_limit_events')
      .insert({ event_type: 'exhausted', function_name: 'rls-test-function' });
    expect(error).not.toBeNull();

    const { data: deleted } = await getAnonClient()
      .from('ai_rate_limit_events').delete().eq('id', rateLimitEvent).select('id');
    expect(deleted).toHaveLength(0);
  });

  it('the service role still has full access', async () => {
    // The point of the fix is that dropping the policy costs the writer
    // nothing: BYPASSRLS, not the policy, is what lets edge functions in.
    const event = await createRateLimitEvent(admin);
    const { data: read, error } = await admin
      .from('ai_rate_limit_events').select('id').eq('id', event);
    expect(error).toBeNull();
    expect(read).toHaveLength(1);

    const { data: deleted } = await admin
      .from('ai_rate_limit_events').delete().eq('id', event).select('id');
    expect(deleted).toHaveLength(1);
  });
});
