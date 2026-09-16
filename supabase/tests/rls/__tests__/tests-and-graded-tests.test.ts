// Tables under test:
//   * public.tests
//   * public.test_questions
//   * public.offering_tests
//   * public.graded_tests
//   * public.graded_test_questions
//
// Printable tests, their question list, their assignment to a section, and the
// OCR-graded paper-test pipeline.
//
// These five are dormant: no page under src/ and no edge function reads or
// writes them (`export-data` reads `graded_tests` for the GDPR export, and
// that is all). They are covered here anyway, because RLS is enabled on all
// five and PostgREST serves them to any authenticated caller — an unused table
// with a wrong policy leaks exactly as well as a used one, and it will be
// wired up eventually with nobody re-checking the policy.
//
// Because they carry no live traffic the suite asserts the load-bearing
// properties — tenant isolation, owner-only student reads, instructor scoping,
// and the published gate — rather than enumerating every policy branch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuestion,
  createTest,
  addTestQuestion,
  createOfferingTest,
  createGradedTest,
  createGradedTestQuestion,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('tests + test_questions + offering_tests + graded_tests RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA: string;
  let offeringA: string;

  let instB: string;
  let courseB: string;

  let publishedTest: string;
  let draftTest: string;
  let publishedTestQuestion: string;
  let draftTestQuestion: string;
  let offeringTestPublished: string;
  let offeringTestUnpublished: string;
  let foreignTest: string;

  let ownGradedTest: string;
  let peerGradedTest: string;
  let ownGradedQuestion: string;
  let peerGradedQuestion: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient;
  let peerId: string;
  let instructorClient: SupabaseClient;
  let adminAClient: SupabaseClient;
  let outsiderClient: SupabaseClient; // instructor in institution B

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Tests A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    offeringA = await createOffering(admin, classA, courseA);

    instB = await createInstitution(admin, `RLS Tests B ${uid}`);
    courseB = await createCourse(admin, instB);

    const stu = await createTestUserClient(admin, `rls-tst-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-tst-peer-${uid}@test.local`);
    peerClient = peer.client; peerId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-tst-instr-${uid}@test.local`);
    instructorClient = instr.client; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const adm = await createTestUserClient(admin, `rls-tst-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const out = await createTestUserClient(admin, `rls-tst-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'instructor');
    await assignCourseInstructor(admin, courseB, out.userId);

    publishedTest = await createTest(admin, courseA, { isPublished: true });
    draftTest = await createTest(admin, courseA, { isPublished: false });
    foreignTest = await createTest(admin, courseB, { isPublished: true });

    publishedTestQuestion = await addTestQuestion(
      admin, publishedTest, await createQuestion(admin, courseA)
    );
    draftTestQuestion = await addTestQuestion(
      admin, draftTest, await createQuestion(admin, courseA)
    );

    offeringTestPublished = await createOfferingTest(admin, offeringA, publishedTest, {
      published: true,
    });
    offeringTestUnpublished = await createOfferingTest(admin, offeringA, draftTest, {
      published: false,
    });

    ownGradedTest = await createGradedTest(admin, courseA, {
      studentId, answerKey: 'the answer key',
    });
    peerGradedTest = await createGradedTest(admin, courseA, { studentId: peerId });
    ownGradedQuestion = await createGradedTestQuestion(admin, ownGradedTest);
    peerGradedQuestion = await createGradedTestQuestion(admin, peerGradedTest);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // tests
  // =====================================================================

  it('student sees a published test in a course they can access', async () => {
    const { data, error } = await studentClient
      .from('tests').select('id').eq('id', publishedTest);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student does not see an unpublished test', async () => {
    const { data, error } = await studentClient
      .from('tests').select('id').eq('id', draftTest);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('assigned instructor sees both published and unpublished tests', async () => {
    const { data, error } = await instructorClient
      .from('tests').select('id').in('id', [publishedTest, draftTest]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('instructor of another institution sees neither', async () => {
    const { data, error } = await outsiderClient
      .from('tests').select('id').in('id', [publishedTest, draftTest]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('nobody in this institution sees the other institution’s test', async () => {
    const { data: byAdmin } = await adminAClient
      .from('tests').select('id').eq('id', foreignTest);
    expect(byAdmin).toHaveLength(0);

    const { data: byInstructor } = await instructorClient
      .from('tests').select('id').eq('id', foreignTest);
    expect(byInstructor).toHaveLength(0);
  });

  it('student cannot create, edit or delete a test', async () => {
    const { error: insertError } = await studentClient
      .from('tests').insert({ course_id: courseA, title: 'student-made test' });
    expect(insertError).not.toBeNull();

    const { data: updated } = await studentClient
      .from('tests').update({ title: 'renamed' }).eq('id', publishedTest).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await studentClient
      .from('tests').delete().eq('id', publishedTest).select();
    expect(deleted).toHaveLength(0);
  });

  it('assigned instructor can create and publish a test', async () => {
    const { data, error } = await instructorClient
      .from('tests')
      .insert({ course_id: courseA, title: `instructor test ${uid}`, is_published: true })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('instructor of another institution cannot create a test here', async () => {
    const { error } = await outsiderClient
      .from('tests').insert({ course_id: courseA, title: 'cross-tenant test' });
    expect(error).not.toBeNull();
  });

  // =====================================================================
  // test_questions
  // =====================================================================

  it('student sees the question list of a test they can see, and not of one they cannot', async () => {
    // test_questions states no published predicate of its own — it inherits
    // the gate from `tests` because the EXISTS subquery is itself under
    // `tests` RLS. Same coupling as the open-question tables.
    const { data: visible, error } = await studentClient
      .from('test_questions').select('id').eq('id', publishedTestQuestion);
    expect(error).toBeNull();
    expect(visible).toHaveLength(1);

    const { data: hidden } = await studentClient
      .from('test_questions').select('id').eq('id', draftTestQuestion);
    expect(hidden).toHaveLength(0);
  });

  it('student cannot add or remove a question from a test', async () => {
    const q = await createQuestion(admin, courseA);
    const { error } = await studentClient
      .from('test_questions').insert({ test_id: publishedTest, question_id: q });
    expect(error).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('test_questions').delete().eq('id', publishedTestQuestion).select();
    expect(deleted).toHaveLength(0);
  });

  it('instructor of another institution sees no question list of this one', async () => {
    const { data, error } = await outsiderClient
      .from('test_questions').select('id').in('id', [publishedTestQuestion, draftTestQuestion]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // offering_tests
  // =====================================================================

  it('enrolled student sees a published offering test and not an unpublished one', async () => {
    const { data: pub, error } = await studentClient
      .from('offering_tests').select('id').eq('id', offeringTestPublished);
    expect(error).toBeNull();
    expect(pub).toHaveLength(1);

    const { data: unpub } = await studentClient
      .from('offering_tests').select('id').eq('id', offeringTestUnpublished);
    expect(unpub).toHaveLength(0);
  });

  it('assigned instructor can assign a test to their offering', async () => {
    const t = await createTest(admin, courseA, { isPublished: true });
    const { data, error } = await instructorClient
      .from('offering_tests')
      .insert({ offering_id: offeringA, test_id: t, published_at: new Date().toISOString() })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot assign or unassign an offering test', async () => {
    const t = await createTest(admin, courseA, { isPublished: true });
    const { error } = await studentClient
      .from('offering_tests').insert({ offering_id: offeringA, test_id: t });
    expect(error).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('offering_tests').delete().eq('id', offeringTestPublished).select();
    expect(deleted).toHaveLength(0);
  });

  it('instructor of another institution sees no offering test of this one', async () => {
    const { data, error } = await outsiderClient
      .from('offering_tests').select('id').eq('id', offeringTestPublished);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // graded_tests + graded_test_questions
  // =====================================================================

  it('student reads their own graded test and not a classmate’s', async () => {
    const { data: own, error } = await studentClient
      .from('graded_tests').select('id').eq('id', ownGradedTest);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: peers } = await studentClient
      .from('graded_tests').select('id').eq('id', peerGradedTest);
    expect(peers).toHaveLength(0);
  });

  it('student reads their own per-question breakdown and not a classmate’s', async () => {
    const { data: own, error } = await studentClient
      .from('graded_test_questions').select('id').eq('id', ownGradedQuestion);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: peers } = await studentClient
      .from('graded_test_questions').select('id').eq('id', peerGradedQuestion);
    expect(peers).toHaveLength(0);
  });

  it('the student-visible row includes answer_key at any status', async () => {
    // Documenting, not endorsing. `graded_tests.answer_key` and
    // `grading_criteria` sit on the same row the student may read, and the
    // SELECT policy is `student_id = auth.uid()` with no status predicate —
    // so a row created as status='uploaded' exposes its answer key before
    // grading finishes. Harmless while the table is dormant, and worth
    // settling before anything writes to it.
    const { data, error } = await studentClient
      .from('graded_tests').select('status, answer_key').eq('id', ownGradedTest).single();
    expect(error).toBeNull();
    expect(data?.status).toBe('uploaded');
    expect(data?.answer_key).toBe('the answer key');
  });

  it('student cannot alter their own grade', async () => {
    const { data: updatedTest } = await studentClient
      .from('graded_tests').update({ total_score: 100 }).eq('id', ownGradedTest).select();
    expect(updatedTest).toHaveLength(0);

    const { data: updatedQuestion } = await studentClient
      .from('graded_test_questions')
      .update({ awarded_points: 10 }).eq('id', ownGradedQuestion).select();
    expect(updatedQuestion).toHaveLength(0);
  });

  it('assigned instructor reads and grades any graded test in their course', async () => {
    const { data: read, error } = await instructorClient
      .from('graded_tests').select('id').in('id', [ownGradedTest, peerGradedTest]);
    expect(error).toBeNull();
    expect(read).toHaveLength(2);

    const { data: updated, error: updateError } = await instructorClient
      .from('graded_test_questions')
      .update({ instructor_feedback: 'see me' }).eq('id', ownGradedQuestion).select('id');
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
  });

  it('instructor of another institution reads no graded test of this one', async () => {
    const { data, error } = await outsiderClient
      .from('graded_tests').select('id').in('id', [ownGradedTest, peerGradedTest]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: questions } = await outsiderClient
      .from('graded_test_questions').select('id').in('id', [ownGradedQuestion, peerGradedQuestion]);
    expect(questions).toHaveLength(0);
  });
});
