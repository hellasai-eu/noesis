// Graded test scans, at both layers (#1104, part of #1097).
//
// A `graded_tests` row is a photograph of a student's handwritten paper, its
// OCR, and their name as read off the page. `20260726000000` calls it out when
// moving `student_id` to CASCADE: "the scan, OCR text and student name are the
// subject's".
//
// Two layers were wrong, and the storage one was wrong in a bigger way than
// the row one:
//
//   * `graded_tests` / `graded_test_questions` — `is_course_instructor`, so
//     course-wide: a 1Α-restricted instructor read 1Β's papers.
//   * `storage.objects` for the `graded-tests` bucket — `is_super_admin OR
//     EXISTS (user_institutions ui WHERE ui.user_id = auth.uid() AND ui.role IN
//     ('admin','instructor'))`. No course, no section, and no requirement that
//     the reader's institution match the file's, which makes it a
//     cross-*institution* hole and makes the row policy decorative.
//
// The `outsiderClient` below is what pins that second one: an instructor of a
// wholly different institution, which no existing suite constructs and which
// the old bucket policy let through.
//
// No suite touched `graded_tests` at all before this one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSectionRestriction,
  createGradedTest,
  createGradedTestQuestion,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

const BUCKET = 'graded-tests';

function tinyPng(): Uint8Array {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fileBlob(): Blob {
  return new Blob([tinyPng()], { type: 'image/png' });
}

function ids(data: unknown): string[] {
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe('graded test scans are section-scoped, at the row and the object', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;

  let classAId: string;
  let classBId: string;

  let instrA: SupabaseClient; // restricted to section A
  let instrB: SupabaseClient; // restricted to section B
  let unrestricted: SupabaseClient;
  let adminClient: SupabaseClient;
  let studentAClient: SupabaseClient;

  // An instructor in a completely different institution.
  let otherInstitutionId: string;
  let outsiderClient: SupabaseClient;

  // Same institution, teaches student A — but a different course.
  let otherCourseInstructor: SupabaseClient;

  let studentAId: string;
  let studentBId: string;

  let scanAId: string;
  let scanBId: string;
  let questionAId: string;
  let questionBId: string;
  let unmatchedScanId: string;

  let scanAPath: string;
  let scanBPath: string;
  const uploadedPaths: string[] = [];

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS GT ${uid}`);
    courseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    await createOffering(admin, classBId, courseId);

    const a = await createTestUserClient(admin, `rls-gt-a-${uid}@test.local`);
    instrA = a.client;
    userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, a.userId);
    await addSectionRestriction(admin, courseId, classAId, a.userId);

    const b = await createTestUserClient(admin, `rls-gt-b-${uid}@test.local`);
    instrB = b.client;
    userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, b.userId);
    await addSectionRestriction(admin, courseId, classBId, b.userId);

    const u = await createTestUserClient(admin, `rls-gt-u-${uid}@test.local`);
    unrestricted = u.client;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    const ia = await createTestUserClient(admin, `rls-gt-adm-${uid}@test.local`);
    adminClient = ia.client;
    userIds.push(ia.userId);
    await addUserToInstitution(admin, ia.userId, institutionId, 'admin');

    // Different tenant entirely — the reader the old bucket policy admitted.
    otherInstitutionId = await createInstitution(admin, `RLS GT Other ${uid}`);
    const out = await createTestUserClient(admin, `rls-gt-out-${uid}@test.local`);
    outsiderClient = out.client;
    userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, otherInstitutionId, 'instructor');

    const sa = await createTestUserClient(admin, `rls-gt-stu-a-${uid}@test.local`);
    studentAId = sa.userId;
    studentAClient = sa.client;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    // A second course, taught to the same class, by somebody else. They reach
    // student A — just not in the course the scan belongs to.
    const otherCourseId = await createCourse(admin, institutionId);
    await createOffering(admin, classAId, otherCourseId);
    const oc = await createTestUserClient(admin, `rls-gt-othercourse-${uid}@test.local`);
    otherCourseInstructor = oc.client;
    userIds.push(oc.userId);
    await addUserToInstitution(admin, oc.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, oc.userId);

    const sb = await createTestUserClient(admin, `rls-gt-stu-b-${uid}@test.local`);
    studentBId = sb.userId;
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    scanAId = await createGradedTest(admin, courseId, { studentId: studentAId });
    scanBId = await createGradedTest(admin, courseId, { studentId: studentBId });
    // Uploaded but not yet matched to a student — no section to check.
    unmatchedScanId = await createGradedTest(admin, courseId, { studentId: null });

    questionAId = await createGradedTestQuestion(admin, scanAId);
    questionBId = await createGradedTestQuestion(admin, scanBId);

    // `<student id>/<course id>/<file>` — the first segment is the prefix
    // erasure.ts walks, the second names the course so the storage policy can
    // apply the same rule the row policy does.
    scanAPath = `${studentAId}/${courseId}/${crypto.randomUUID()}-paper.png`;
    scanBPath = `${studentBId}/${courseId}/${crypto.randomUUID()}-paper.png`;
    for (const path of [scanAPath, scanBPath]) {
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
      if (error) throw new Error(`seed upload ${path}: ${error.message}`);
      uploadedPaths.push(path);
    }
  });

  afterAll(async () => {
    if (uploadedPaths.length > 0) {
      await admin.storage.from(BUCKET).remove(uploadedPaths);
    }
    // CLAUDE.md's "no cleanup" rule is scoped to E2E, where the target is a
    // shared preview branch and the point is to need no privileged credential.
    // The RLS harness is service-role by construction and runs against a local
    // stack that `db reset` recreates.
    await cleanupScaffold(admin, { institutionId, userIds });
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  // ---- graded_tests -------------------------------------------------------

  it('each restricted instructor reads only their own section\'s papers', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('graded_tests')
      .select('id')
      .in('id', [scanAId, scanBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([scanAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('graded_tests')
      .select('id')
      .in('id', [scanAId, scanBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([scanBId]);
  });

  it('an unrestricted instructor and the institution admin read both', async () => {
    const { data: byInstructor } = await unrestricted
      .from('graded_tests')
      .select('id')
      .in('id', [scanAId, scanBId]);
    expect(ids(byInstructor)).toEqual([scanAId, scanBId].sort());

    const { data: byAdmin } = await adminClient
      .from('graded_tests')
      .select('id')
      .in('id', [scanAId, scanBId]);
    expect(ids(byAdmin)).toEqual([scanAId, scanBId].sort());
  });

  it('a scan not yet matched to a student stays visible to the course\'s instructors', async () => {
    // Deliberate: an unmatched scan has no student, so there is no section to
    // place it in and nobody's identity to protect it on behalf of yet. It is
    // the marking queue. Matching it to a student is what scopes it.
    const { data: seenByA } = await instrA
      .from('graded_tests')
      .select('id')
      .eq('id', unmatchedScanId);
    expect(seenByA).toHaveLength(1);

    const { data: seenByOutsider } = await outsiderClient
      .from('graded_tests')
      .select('id')
      .eq('id', unmatchedScanId);
    expect(seenByOutsider).toHaveLength(0);
  });

  it('a restricted instructor cannot update another section\'s paper', async () => {
    const { error } = await instrA
      .from('graded_tests')
      .update({ status: 'graded' })
      .eq('id', scanBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('graded_tests')
      .select('status')
      .eq('id', scanBId)
      .single();
    expect(data?.status).toBe('uploaded');
  });

  it('a restricted instructor can update their own section\'s paper', async () => {
    const { error } = await instrA
      .from('graded_tests')
      .update({ status: 'graded' })
      .eq('id', scanAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('graded_tests')
      .select('status')
      .eq('id', scanAId)
      .single();
    expect(data?.status).toBe('graded');
  });

  it('a restricted instructor cannot delete another section\'s paper', async () => {
    const { error } = await instrA.from('graded_tests').delete().eq('id', scanBId);
    expect(error).toBeNull();
    const { data } = await admin.from('graded_tests').select('id').eq('id', scanBId);
    expect(data).toHaveLength(1);
  });

  it('the student still reads their own paper row', async () => {
    const { data, error } = await studentAClient
      .from('graded_tests')
      .select('id')
      .eq('id', scanAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // ---- graded_test_questions ---------------------------------------------

  it('per-question marks follow the section of the parent scan', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('graded_test_questions')
      .select('id')
      .in('id', [questionAId, questionBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([questionAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('graded_test_questions')
      .select('id')
      .in('id', [questionAId, questionBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([questionBId]);
  });

  it('a restricted instructor cannot re-mark another section\'s question', async () => {
    const { error } = await instrA
      .from('graded_test_questions')
      .update({ awarded_points: 0, instructor_feedback: 'tampered' })
      .eq('id', questionBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('graded_test_questions')
      .select('awarded_points')
      .eq('id', questionBId)
      .single();
    expect(Number(data?.awarded_points)).toBe(7);
  });

  it('a restricted instructor can re-mark their own section\'s question', async () => {
    const { error } = await instrA
      .from('graded_test_questions')
      .update({ awarded_points: 9 })
      .eq('id', questionAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('graded_test_questions')
      .select('awarded_points')
      .eq('id', questionAId)
      .single();
    expect(Number(data?.awarded_points)).toBe(9);
  });

  // ---- storage.objects ----------------------------------------------------

  it('a restricted instructor can download their own section\'s scan', async () => {
    const { data, error } = await instrA.storage.from(BUCKET).download(scanAPath);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('a restricted instructor cannot download another section\'s scan', async () => {
    const { data, error } = await instrA.storage.from(BUCKET).download(scanBPath);
    // Storage RLS answers with an error or a null body; both are denial.
    expect(!!error || data === null).toBe(true);
  });

  it('an instructor in another institution cannot download any scan', async () => {
    // The bucket policy asked only for an instructor row in *some* institution,
    // so this reader could previously fetch every scan in the system.
    for (const path of [scanAPath, scanBPath]) {
      const { data, error } = await outsiderClient.storage.from(BUCKET).download(path);
      expect(!!error || data === null).toBe(true);
    }
  });

  it('an instructor in another institution cannot upload into a student\'s prefix', async () => {
    const path = `${studentAId}/${courseId}/${crypto.randomUUID()}-forged.png`;
    const { error } = await outsiderClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();
  });

  it('a restricted instructor cannot upload into another section\'s prefix', async () => {
    const forgedPath = `${studentBId}/${courseId}/${crypto.randomUUID()}-forged.png`;
    const { error: refused } = await instrA.storage
      .from(BUCKET)
      .upload(forgedPath, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(refused).not.toBeNull();

    // Control: the same upload under their own section's student goes through,
    // so the refusal above is the section rule and not the bucket being shut.
    const ownPath = `${studentAId}/${courseId}/${crypto.randomUUID()}-ok.png`;
    const { error: allowed } = await instrA.storage
      .from(BUCKET)
      .upload(ownPath, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(allowed).toBeNull();
    uploadedPaths.push(ownPath);
  });

  it('a restricted instructor cannot delete another section\'s scan', async () => {
    await instrA.storage.from(BUCKET).remove([scanBPath]);
    // `remove` reports success even where RLS matched no row, so the file still
    // being downloadable by someone entitled to it is the real assertion.
    const { data } = await admin.storage.from(BUCKET).download(scanBPath);
    expect(data).not.toBeNull();
  });

  it('an instructor who teaches the student elsewhere cannot open this course\'s scan', async () => {
    // The object name has to name the course, not just the student. Asking only
    // "may this user reach this student anywhere?" would let whoever teaches
    // them Maths open their Physics paper — a cross-course leak the row policy
    // does not have, because `graded_tests` carries `course_id`.
    const { data: seen } = await otherCourseInstructor.storage
      .from(BUCKET)
      .download(scanAPath);
    expect(seen).toBeNull();
  });

  it('a name that does not carry both ids is refused', async () => {
    // The old single-segment layout, and anything else malformed, fails closed
    // rather than raising on the cast.
    const legacyPath = `${studentAId}/${crypto.randomUUID()}-legacy.png`;
    const { error } = await instrA.storage
      .from(BUCKET)
      .upload(legacyPath, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();
  });

  it('a student cannot upload or delete under their own prefix', async () => {
    // The prefix is the student's, but these policies gate writes: a student
    // must not be able to add a forged scan or remove their own marked paper.
    const path = `${studentAId}/${courseId}/${crypto.randomUUID()}-selfserve.png`;
    const { error } = await studentAClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();

    await studentAClient.storage.from(BUCKET).remove([scanAPath]);
    const { data } = await admin.storage.from(BUCKET).download(scanAPath);
    expect(data).not.toBeNull();
  });
});
