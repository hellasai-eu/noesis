// Tables under test:
//   * public.course_notes
//   * public.course_note_offerings
//
// Instructor-distributed documents (20260831120000). The shape is deliberately
// the same as class_announcements: the note row carries only a course_id, and
// `course_note_offerings` decides which sections receive it. The SELECT policy
// for a non-manager requires a targeting row for an offering they can reach, so
// an untargeted note is a draft — visible to whoever can manage the course, and
// to nobody else.
//
// The part with no announcement equivalent is the FILE. The bytes live in a
// private `course-notes` bucket under a `<course_id>/` prefix, and three
// storage.objects policies re-derive the same permission:
//
//   * INSERT authorises against the course id in the key, because the upload
//     necessarily happens before the row that would otherwise authorise it;
//   * SELECT authorises against the row that owns the object, falling back to
//     the key prefix for managers so an orphan is still reachable;
//   * DELETE is managers only.
//
// Those are asserted here through the same SQL helpers the table policies use
// (`can_manage_course_notes`, `can_read_course_note_file`), evaluated as each
// user, because storage.objects policies are not reachable through PostgREST.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseNote,
  targetNoteAtOffering,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';
import { queryScalar } from '../helpers/sql';

/**
 * Evaluate a boolean predicate with `auth.uid()` resolving to `userId`, the
 * way a policy on `storage.objects` would.
 *
 * psql connects as the `postgres` superuser, where `auth.uid()` is NULL and
 * every one of these helpers would answer false for everybody — so the claim
 * has to be planted first, in the same transaction.
 *
 * It has to be ONE statement: `queryScalar` runs psql without `-q`, so a
 * multi-statement batch would prefix the answer with `BEGIN` / `DO` command
 * tags. `set_config` is volatile, so the CTE is never inlined, and routing the
 * predicate through `cfg.c` puts it in a target list evaluated per row of that
 * CTE's output — after the claim is in place, rather than hoisted ahead of it
 * as an uncorrelated InitPlan would be.
 */
function asUser(userId: string, predicate: string): boolean {
  return (
    queryScalar(`
      WITH cfg AS MATERIALIZED (
        SELECT set_config(
          'request.jwt.claims',
          json_build_object('sub', '${userId}', 'role', 'authenticated')::text,
          true
        ) AS c
      )
      SELECT CASE WHEN cfg.c IS NOT NULL THEN (${predicate}) END FROM cfg
    `) === 't'
  );
}

describe('course notes RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA1: string;
  let classA2: string;
  let offeringA1: string;
  let offeringA2: string;

  let instB: string;
  let courseB: string;
  let classB: string;
  let offeringB: string;

  let targetedNote: { id: string; filePath: string }; // targeted at offeringA1
  let otherSectionNote: { id: string; filePath: string }; // targeted at offeringA2
  let draftNote: { id: string; filePath: string }; // no targeting row
  let foreignNote: { id: string; filePath: string };

  let studentClient: SupabaseClient; // class A1
  let studentId: string;
  let otherSectionStudentClient: SupabaseClient; // class A2
  let instructorClient: SupabaseClient;
  let instructorId: string;
  let coTeacherClient: SupabaseClient;
  let coTeacherId: string;
  let outsiderClient: SupabaseClient;
  let outsiderId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Notes A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA1 = await createClass(admin, instA);
    classA2 = await createClass(admin, instA);
    offeringA1 = await createOffering(admin, classA1, courseA);
    offeringA2 = await createOffering(admin, classA2, courseA);

    instB = await createInstitution(admin, `RLS Notes B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);
    offeringB = await createOffering(admin, classB, courseB);

    const stu = await createTestUserClient(admin, `rls-notes-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA1, stu.userId, 'student');

    const other = await createTestUserClient(admin, `rls-notes-other-${uid}@test.local`);
    otherSectionStudentClient = other.client; userIds.push(other.userId);
    await addUserToInstitution(admin, other.userId, instA, 'student');
    await enrollInClass(admin, classA2, other.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-notes-instr-${uid}@test.local`);
    instructorClient = instr.client; instructorId = instr.userId; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    // A second instructor on the SAME course — course material is shared, so
    // the pair is what proves authorship binding did not become authorship
    // ownership.
    const co = await createTestUserClient(admin, `rls-notes-co-${uid}@test.local`);
    coTeacherClient = co.client; coTeacherId = co.userId; userIds.push(co.userId);
    await addUserToInstitution(admin, co.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, co.userId);

    const out = await createTestUserClient(admin, `rls-notes-out-${uid}@test.local`);
    outsiderClient = out.client; outsiderId = out.userId; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'student');
    await enrollInClass(admin, classB, out.userId, 'student');

    targetedNote = await createCourseNote(admin, courseA, { title: `targeted ${uid}` });
    await targetNoteAtOffering(admin, targetedNote.id, offeringA1);

    otherSectionNote = await createCourseNote(admin, courseA, { title: `sibling ${uid}` });
    await targetNoteAtOffering(admin, otherSectionNote.id, offeringA2);

    draftNote = await createCourseNote(admin, courseA, { title: `draft ${uid}` });

    foreignNote = await createCourseNote(admin, courseB, { title: `foreign ${uid}` });
    await targetNoteAtOffering(admin, foreignNote.id, offeringB);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // course_notes
  // =====================================================================

  it('student reads a note targeted at their section', async () => {
    const { data, error } = await studentClient
      .from('course_notes').select('id, file_path').eq('id', targetedNote.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student does not read a note targeted at a sibling section', async () => {
    const { data, error } = await studentClient
      .from('course_notes').select('id').eq('id', otherSectionNote.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    // …and the mirror image, so this is targeting rather than an accident.
    const { data: mirror } = await otherSectionStudentClient
      .from('course_notes').select('id').eq('id', otherSectionNote.id);
    expect(mirror).toHaveLength(1);
  });

  it('an untargeted note is a draft — invisible to every student in the course', async () => {
    const { data: bySection1 } = await studentClient
      .from('course_notes').select('id').eq('id', draftNote.id);
    expect(bySection1).toHaveLength(0);

    const { data: bySection2 } = await otherSectionStudentClient
      .from('course_notes').select('id').eq('id', draftNote.id);
    expect(bySection2).toHaveLength(0);

    // The instructor still sees their own draft, which is what makes it a
    // draft rather than a lost row.
    const { data: byInstructor } = await instructorClient
      .from('course_notes').select('id').eq('id', draftNote.id);
    expect(byInstructor).toHaveLength(1);
  });

  it('student of another institution reads no note of this one', async () => {
    const { data, error } = await outsiderClient
      .from('course_notes')
      .select('id')
      .in('id', [targetedNote.id, otherSectionNote.id, draftNote.id]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('assigned instructor can create, target, edit and delete a note', async () => {
    const path = `${courseA}/${crypto.randomUUID()}-instructor.pdf`;
    const { data: created, error } = await instructorClient
      .from('course_notes')
      .insert({
        course_id: courseA,
        title: `instructor note ${uid}`,
        file_path: path,
        file_name: 'instructor.pdf',
        mime_type: 'application/pdf',
        file_size: 2048,
      })
      .select('id').single();
    expect(error).toBeNull();
    const noteId = (created as { id: string }).id;

    const { error: targetError } = await instructorClient
      .from('course_note_offerings')
      .insert({ note_id: noteId, offering_id: offeringA1 });
    expect(targetError).toBeNull();

    const { data: updated } = await instructorClient
      .from('course_notes').update({ title: 'edited' }).eq('id', noteId).select();
    expect(updated).toHaveLength(1);

    const { data: deleted } = await instructorClient
      .from('course_notes').delete().eq('id', noteId).select();
    expect(deleted).toHaveLength(1);
  });

  it('a manager cannot attribute a note to someone else', async () => {
    // `author_id` is what the per-user GDPR export selects on, and the export
    // files a note under the institution of its own course rather than the
    // subject's memberships. Left caller-controlled, a manager here could post
    // a note "by" a student of another institution and have its title and file
    // name turn up in that student's subject access request (20260831140000).
    const { error } = await instructorClient.from('course_notes').insert({
      course_id: courseA,
      author_id: outsiderId,
      title: `forged authorship ${uid}`,
      file_path: `${courseA}/${crypto.randomUUID()}-forged.pdf`,
      file_name: 'forged.pdf',
      mime_type: 'application/pdf',
      file_size: 128,
    });
    expect(error).not.toBeNull();

    // Nor by editing an existing note's attribution afterwards. This is a
    // WITH CHECK violation rather than a USING one — the manager may see and
    // edit the row, just not hand it to someone else — so it comes back as an
    // error, not as zero rows.
    const own = await createCourseNote(admin, courseA, {
      authorId: instructorId,
      title: `reattribution ${uid}`,
    });
    const { error: reattributeError } = await instructorClient
      .from('course_notes')
      .update({ author_id: outsiderId })
      .eq('id', own.id)
      .select();
    expect(reattributeError).not.toBeNull();

    const { data: after } = await admin
      .from('course_notes').select('author_id').eq('id', own.id).single();
    expect(after?.author_id).toBe(instructorId);
  });

  it('a co-teacher can edit a colleague\'s note — authorship is not ownership', async () => {
    // The regression 20260831150000 exists for: binding author_id in a WITH
    // CHECK also applies to UPDATE, where the resulting row still carries the
    // ORIGINAL author. That refused every edit of a colleague's note on a table
    // whose whole purpose is shared course material.
    const colleagues = await createCourseNote(admin, courseA, {
      authorId: instructorId,
      title: `co-teaching ${uid}`,
    });
    await targetNoteAtOffering(admin, colleagues.id, offeringA1);

    const { data: retitled, error } = await coTeacherClient
      .from('course_notes')
      .update({ title: `retitled by colleague ${uid}` })
      .eq('id', colleagues.id)
      .select('id, author_id');
    expect(error).toBeNull();
    expect(retitled).toHaveLength(1);
    // The edit went through without disturbing who wrote it.
    expect(retitled?.[0].author_id).toBe(instructorId);

    // Re-targeting a colleague's note works too.
    const { error: targetError } = await coTeacherClient
      .from('course_note_offerings')
      .insert({ note_id: colleagues.id, offering_id: offeringA2 });
    expect(targetError).toBeNull();

    // …but they still cannot claim it as their own.
    const { error: claimError } = await coTeacherClient
      .from('course_notes')
      .update({ author_id: coTeacherId })
      .eq('id', colleagues.id)
      .select();
    expect(claimError).not.toBeNull();
  });

  it('a note cannot be moved to another course', async () => {
    // Both halves of why (20260831160000). Integrity: targeting rows are
    // matched against the note's own course, so a move orphans every one of
    // them and the note silently vanishes for the students it was distributed
    // to — while the instructor's list still renders their section badges.
    // Disclosure: the export resolves a note's institution through its course,
    // so moving a colleague-authored note across a tenant boundary re-files
    // that author's row under an institution they need not belong to.
    const secondCourse = await createCourse(admin, instA);
    const secondClass = await createClass(admin, instA);
    await createOffering(admin, secondClass, secondCourse);

    const note = await createCourseNote(admin, courseA, { title: `stays put ${uid}` });
    await targetNoteAtOffering(admin, note.id, offeringA1);

    // Even the service role is refused — this is a trigger, not a policy.
    const { error } = await admin
      .from('course_notes')
      .update({ course_id: secondCourse })
      .eq('id', note.id);
    expect(error).not.toBeNull();

    const { data: after } = await admin
      .from('course_notes').select('course_id').eq('id', note.id).single();
    expect(after?.course_id).toBe(courseA);

    // An ordinary edit still goes through — the trigger fires on the column,
    // not on every update.
    const { error: retitleError } = await admin
      .from('course_notes')
      .update({ title: `retitled ${uid}` })
      .eq('id', note.id);
    expect(retitleError).toBeNull();
  });

  it('erasing the author clears attribution without the trigger blocking it', async () => {
    // author_id is ON DELETE SET NULL, and the immutability trigger has to let
    // that cascade through or deleting a user who ever uploaded a note becomes
    // impossible.
    const doomed = await createTestUserClient(admin, `rls-notes-doomed-${uid}@test.local`);
    await addUserToInstitution(admin, doomed.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, doomed.userId);
    const note = await createCourseNote(admin, courseA, {
      authorId: doomed.userId,
      title: `outlives its author ${uid}`,
    });

    const { error } = await admin.auth.admin.deleteUser(doomed.userId);
    expect(error).toBeNull();

    const { data: after } = await admin
      .from('course_notes').select('id, author_id').eq('id', note.id).single();
    // The note survives the author, unattributed.
    expect(after).not.toBeNull();
    expect(after?.author_id).toBeNull();
  });

  it('a manager may still claim their own notes, or leave them unattributed', async () => {
    const claimed = await instructorClient
      .from('course_notes')
      .insert({
        course_id: courseA,
        author_id: instructorId,
        title: `own authorship ${uid}`,
        file_path: `${courseA}/${crypto.randomUUID()}-own.pdf`,
        file_name: 'own.pdf',
        mime_type: 'application/pdf',
        file_size: 128,
      })
      .select('id');
    expect(claimed.error).toBeNull();

    // NULL stays allowed: author_id is ON DELETE SET NULL, so an erased
    // author's notes must remain writable.
    const anonymous = await instructorClient
      .from('course_notes')
      .insert({
        course_id: courseA,
        author_id: null,
        title: `no authorship ${uid}`,
        file_path: `${courseA}/${crypto.randomUUID()}-anon.pdf`,
        file_name: 'anon.pdf',
        mime_type: 'application/pdf',
        file_size: 128,
      })
      .select('id');
    expect(anonymous.error).toBeNull();
  });

  it('student cannot create, edit, delete or target a note', async () => {
    const { error: insertError } = await studentClient
      .from('course_notes')
      .insert({
        course_id: courseA,
        title: 'student note',
        file_path: `${courseA}/${crypto.randomUUID()}-student.pdf`,
        file_name: 'student.pdf',
        mime_type: 'application/pdf',
        file_size: 10,
      });
    expect(insertError).not.toBeNull();

    const { data: updated } = await studentClient
      .from('course_notes').update({ title: 'edited' }).eq('id', targetedNote.id).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await studentClient
      .from('course_notes').delete().eq('id', targetedNote.id).select();
    expect(deleted).toHaveLength(0);

    const { error: targetError } = await studentClient
      .from('course_note_offerings')
      .insert({ note_id: draftNote.id, offering_id: offeringA1 });
    expect(targetError).not.toBeNull();
  });

  it('student sees the targeting row for their own section only', async () => {
    const { data: own, error } = await studentClient
      .from('course_note_offerings')
      .select('note_id').eq('note_id', targetedNote.id);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: other } = await studentClient
      .from('course_note_offerings')
      .select('note_id').eq('note_id', otherSectionNote.id);
    expect(other).toHaveLength(0);
  });

  // =====================================================================
  // storage.objects — the file behind the row
  // =====================================================================

  it('only a course manager may upload under the course prefix', () => {
    const predicate = (course: string) =>
      `public.can_manage_course_notes('${course}'::uuid)`;
    expect(asUser(instructorId, predicate(courseA))).toBe(true);
    expect(asUser(studentId, predicate(courseA))).toBe(false);
    expect(asUser(outsiderId, predicate(courseA))).toBe(false);
    // …and not into a course they do not teach.
    expect(asUser(instructorId, predicate(courseB))).toBe(false);
  });

  it('a targeted student may read the file, a sibling-section student may not', () => {
    const read = (path: string) =>
      `public.can_read_course_note_file('${path.replace(/'/g, "''")}')`;
    expect(asUser(studentId, read(targetedNote.filePath))).toBe(true);
    expect(asUser(studentId, read(otherSectionNote.filePath))).toBe(false);
    // The draft's bytes are as unreachable as its row.
    expect(asUser(studentId, read(draftNote.filePath))).toBe(false);
    // The instructor reads all three, drafts included.
    expect(asUser(instructorId, read(targetedNote.filePath))).toBe(true);
    expect(asUser(instructorId, read(draftNote.filePath))).toBe(true);
    // Another institution reaches none of them.
    expect(asUser(outsiderId, read(targetedNote.filePath))).toBe(false);
    expect(asUser(studentId, read(foreignNote.filePath))).toBe(false);
  });

  it('a key with a non-uuid prefix fails closed rather than raising', () => {
    // The policies cast the first path segment to uuid; without the guard a
    // single malformed object name would abort the whole statement with 22P02.
    expect(queryScalar(`SELECT public.course_notes_path_course_id('not-a-uuid/x.pdf') IS NULL`).trim())
      .toBe('t');
    expect(queryScalar(`SELECT public.course_notes_path_course_id('${courseA}/x.pdf')::text`).trim())
      .toBe(courseA);
  });

  it('an unreferenced key is readable by nobody, not even a manager, via the row path', () => {
    const orphan = `${courseA}/${crypto.randomUUID()}-orphan.pdf`;
    // No course_notes row points at it, so the row-based arm says no. The
    // manager still reaches it through the prefix arm of the SELECT policy,
    // which is what lets a failed upload be cleaned up.
    expect(asUser(instructorId, `public.can_read_course_note_file('${orphan}')`)).toBe(false);
    expect(asUser(instructorId, `public.can_manage_course_notes('${courseA}'::uuid)`)).toBe(true);
    expect(asUser(studentId, `public.can_read_course_note_file('${orphan}')`)).toBe(false);
  });

  // =====================================================================
  // Lifecycle
  // =====================================================================

  it('deleting the note deletes its targeting rows', async () => {
    const note = await createCourseNote(admin, courseA, { title: `cascade ${uid}` });
    await targetNoteAtOffering(admin, note.id, offeringA1);

    await admin.from('course_notes').delete().eq('id', note.id);

    const { data } = await admin
      .from('course_note_offerings').select('note_id').eq('note_id', note.id);
    expect(data).toHaveLength(0);
  });

  it('rejects a file name whose extension is not a document type', async () => {
    const { error } = await admin.from('course_notes').insert({
      course_id: courseA,
      title: 'executable',
      file_path: `${courseA}/${crypto.randomUUID()}-payload.exe`,
      file_name: 'payload.exe',
      mime_type: 'application/octet-stream',
      file_size: 10,
    });
    expect(error).not.toBeNull();

    // The dangerous shape: an allowed extension that is not the final one.
    const { error: doubleExt } = await admin.from('course_notes').insert({
      course_id: courseA,
      title: 'disguised',
      file_path: `${courseA}/${crypto.randomUUID()}-report.pdf.exe`,
      file_name: 'report.pdf.exe',
      mime_type: 'application/octet-stream',
      file_size: 10,
    });
    expect(doubleExt).not.toBeNull();
  });

  it('rejects a file larger than the bucket ceiling', async () => {
    const { error } = await admin.from('course_notes').insert({
      course_id: courseA,
      title: 'too big',
      file_path: `${courseA}/${crypto.randomUUID()}-big.pdf`,
      file_name: 'big.pdf',
      mime_type: 'application/pdf',
      file_size: 26214401,
    });
    expect(error).not.toBeNull();
  });

  it('refuses two rows claiming the same object', async () => {
    const first = await createCourseNote(admin, courseA, { title: `unique ${uid}` });
    const { error } = await admin.from('course_notes').insert({
      course_id: courseA,
      title: 'duplicate key',
      file_path: first.filePath,
      file_name: 'rls-note.pdf',
      mime_type: 'application/pdf',
      file_size: 1024,
    });
    expect(error).not.toBeNull();
  });
});
