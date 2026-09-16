// Tables under test: public.student_admin_notes
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260603200000_add_student_admin_notes.sql
//       - CREATE TABLE student_admin_notes, RLS policies
//         "Admins and teaching instructors can read student notes",
//         "Admins can insert/update/delete student notes",
//         audit table + trigger (out of scope for this test file)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createStudentAdminNote,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('student_admin_notes RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;
  let courseId: string;
  let classId: string;
  let noteId: string;
  let otherInstitutionNoteId: string;

  let adminClient: SupabaseClient;
  let superAdminClient: SupabaseClient;
  let teachingInstructorClient: SupabaseClient;
  let nonTeachingInstructorClient: SupabaseClient;
  let studentSelfClient: SupabaseClient;
  let studentSelfId: string;
  let otherStudentClient: SupabaseClient;
  let otherInstAdminClient: SupabaseClient;

  const userIds: string[] = [];
  const superAdminEmail = `rls-san-sa-${uid}@test.local`;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS SAN ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS SAN Other ${uid}`);

    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);

    const adm = await createTestUserClient(admin, `rls-san-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    const teaching = await createTestUserClient(admin, `rls-san-tinst-${uid}@test.local`);
    teachingInstructorClient = teaching.client; userIds.push(teaching.userId);
    await addUserToInstitution(admin, teaching.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, teaching.userId);

    const nonTeaching = await createTestUserClient(admin, `rls-san-ntinst-${uid}@test.local`);
    nonTeachingInstructorClient = nonTeaching.client; userIds.push(nonTeaching.userId);
    await addUserToInstitution(admin, nonTeaching.userId, institutionId, 'instructor');
    // intentionally not assigned to any course

    const stu = await createTestUserClient(admin, `rls-san-stu-${uid}@test.local`);
    studentSelfClient = stu.client; studentSelfId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const otherStu = await createTestUserClient(admin, `rls-san-stu2-${uid}@test.local`);
    otherStudentClient = otherStu.client; userIds.push(otherStu.userId);
    await addUserToInstitution(admin, otherStu.userId, institutionId, 'student');

    const otherAdm = await createTestUserClient(admin, `rls-san-otheradm-${uid}@test.local`);
    otherInstAdminClient = otherAdm.client; userIds.push(otherAdm.userId);
    await addUserToInstitution(admin, otherAdm.userId, otherInstitutionId, 'admin');

    noteId = await createStudentAdminNote(admin, studentSelfId, institutionId, {
      body: `Original note ${uid}`,
    });
    otherInstitutionNoteId = await createStudentAdminNote(
      admin,
      studentSelfId,
      otherInstitutionId,
      { body: `Cross-institution note ${uid}` }
    );
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await admin.from('user_institutions').delete().eq('institution_id', otherInstitutionId);
    await admin.from('student_admin_notes').delete().eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // SELECT
  it('institution admin can read the note', async () => {
    const { data, error } = await adminClient
      .from('student_admin_notes').select('id, body').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super-admin can read the note', async () => {
    const { data, error } = await superAdminClient
      .from('student_admin_notes').select('id').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('teaching instructor (assigned + student enrolled) can read the note', async () => {
    const { data, error } = await teachingInstructorClient
      .from('student_admin_notes').select('id').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-teaching instructor cannot read the note', async () => {
    const { data, error } = await nonTeachingInstructorClient
      .from('student_admin_notes').select('id').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('the student subject of the note cannot read their own note', async () => {
    const { data, error } = await studentSelfClient
      .from('student_admin_notes').select('id').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('other student in the institution cannot read the note', async () => {
    const { data, error } = await otherStudentClient
      .from('student_admin_notes').select('id').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin from a different institution cannot read the note', async () => {
    const { data, error } = await otherInstAdminClient
      .from('student_admin_notes').select('id').eq('id', noteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin cannot read notes scoped to a different institution', async () => {
    const { data, error } = await adminClient
      .from('student_admin_notes').select('id').eq('id', otherInstitutionNoteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // INSERT
  it('institution admin can insert a note', async () => {
    const { data, error } = await adminClient
      .from('student_admin_notes')
      .insert({
        student_user_id: studentSelfId,
        institution_id: institutionId,
        body: `Inserted by admin ${uid}`,
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('teaching instructor cannot insert a note', async () => {
    const { error } = await teachingInstructorClient
      .from('student_admin_notes')
      .insert({
        student_user_id: studentSelfId,
        institution_id: institutionId,
        body: `Blocked instructor insert ${uid}`,
      });
    expect(error).not.toBeNull();
  });

  it('student cannot insert a note about themselves', async () => {
    const { error } = await studentSelfClient
      .from('student_admin_notes')
      .insert({
        student_user_id: studentSelfId,
        institution_id: institutionId,
        body: `Self-write attempt ${uid}`,
      });
    expect(error).not.toBeNull();
  });

  it('admin from a different institution cannot insert a note in this institution', async () => {
    const { error } = await otherInstAdminClient
      .from('student_admin_notes')
      .insert({
        student_user_id: studentSelfId,
        institution_id: institutionId,
        body: `Cross-institution insert ${uid}`,
      });
    expect(error).not.toBeNull();
  });

  // UPDATE
  it('institution admin can update a note', async () => {
    const { data, error } = await adminClient
      .from('student_admin_notes')
      .update({ body: `Edited by admin ${uid}` })
      .eq('id', noteId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('teaching instructor cannot update a note', async () => {
    const { data } = await teachingInstructorClient
      .from('student_admin_notes')
      .update({ body: `Should not stick ${uid}` })
      .eq('id', noteId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('student cannot update a note about themselves', async () => {
    const { data } = await studentSelfClient
      .from('student_admin_notes')
      .update({ body: `Should not stick ${uid}` })
      .eq('id', noteId)
      .select();
    expect(data).toHaveLength(0);
  });

  // DELETE
  it('institution admin can delete a note', async () => {
    const tmpId = await createStudentAdminNote(admin, studentSelfId, institutionId, {
      body: `ToDelete ${uid}`,
    });
    const { data, error } = await adminClient
      .from('student_admin_notes')
      .delete().eq('id', tmpId).select();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('teaching instructor cannot delete a note', async () => {
    const { data } = await teachingInstructorClient
      .from('student_admin_notes').delete().eq('id', noteId).select();
    expect(data).toHaveLength(0);
  });

  it('student cannot delete a note about themselves', async () => {
    const { data } = await studentSelfClient
      .from('student_admin_notes').delete().eq('id', noteId).select();
    expect(data).toHaveLength(0);
  });
});
