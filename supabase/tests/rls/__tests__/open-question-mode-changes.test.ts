import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createOpenTypeQuestion,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

// RLS surface for the #596 audit table:
//   * Students must NEVER see it (audit log includes admin identity + counts).
//   * Course instructors / institution admins may read entries for their
//     course only.
//   * Writes are service-role only — the edge function inserts; no
//     authenticated client may.
describe('open_question_mode_changes RLS (#596)', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let questionId: string;
  let auditId: string;

  let instructorClient: SupabaseClient;
  let instructorId: string;
  let studentClient: SupabaseClient;
  let studentId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS ModeChanges ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    questionId = await createOpenTypeQuestion(admin, courseId);

    const inst = await createTestUserClient(admin, `rls-omc-inst-${uid}@test.local`);
    instructorClient = inst.client; instructorId = inst.userId; userIds.push(inst.userId);
    await addUserToInstitution(admin, instructorId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, instructorId);

    const stu = await createTestUserClient(admin, `rls-omc-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, studentId, institutionId, 'student');
    await enrollInClass(admin, classId, studentId, 'student');

    // Seed one audit row as the admin (service role).
    const { data, error } = await admin
      .from('open_question_mode_changes')
      .insert({
        question_id: questionId,
        course_id: courseId,
        changed_by: instructorId,
        prior_mode: 'interactive',
        new_mode: 'single',
        deleted_counts: { open_question_chats: 0 },
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed audit: ${error.message}`);
    auditId = data.id;
  });

  afterAll(async () => {
    await admin.from('open_question_mode_changes').delete().eq('id', auditId);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('students cannot read the audit log', async () => {
    const { data, error } = await studentClient
      .from('open_question_mode_changes')
      .select('id')
      .eq('id', auditId);
    // RLS returns no rows (no policy applies) — never an error.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('students cannot insert into the audit log', async () => {
    const { error } = await studentClient
      .from('open_question_mode_changes')
      .insert({
        question_id: questionId,
        course_id: courseId,
        changed_by: studentId,
        prior_mode: 'interactive',
        new_mode: 'single',
        deleted_counts: {},
      });
    expect(error).not.toBeNull();
  });

  it('the course instructor CAN read entries for their course', async () => {
    const { data, error } = await instructorClient
      .from('open_question_mode_changes')
      .select('id, prior_mode, new_mode')
      .eq('id', auditId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].prior_mode).toBe('interactive');
    expect(data![0].new_mode).toBe('single');
  });

  it('even instructors cannot directly insert (writes are service-role only)', async () => {
    const { error } = await instructorClient
      .from('open_question_mode_changes')
      .insert({
        question_id: questionId,
        course_id: courseId,
        changed_by: instructorId,
        prior_mode: 'single',
        new_mode: 'interactive',
        deleted_counts: {},
      });
    expect(error).not.toBeNull();
  });
});
