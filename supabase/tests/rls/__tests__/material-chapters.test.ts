import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseMaterial,
  createMaterialChapter,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('material_chapters RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let materialId: string;
  let chapterId: string;

  let adminClient: SupabaseClient;
  let instructorClient: SupabaseClient;
  let studentClient: SupabaseClient;
  let unenrolledClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Chapters ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    materialId = await createCourseMaterial(admin, courseId);
    chapterId = await createMaterialChapter(admin, materialId);

    const adm = await createTestUserClient(admin, `rls-ch-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const inst = await createTestUserClient(admin, `rls-ch-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const stu = await createTestUserClient(admin, `rls-ch-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const unenr = await createTestUserClient(admin, `rls-ch-unenr-${uid}@test.local`);
    unenrolledClient = unenr.client; userIds.push(unenr.userId);
    await addUserToInstitution(admin, unenr.userId, institutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('admin can see chapters', async () => {
    const { data, error } = await adminClient
      .from('material_chapters').select('id').eq('id', chapterId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('assigned instructor can see chapters', async () => {
    const { data, error } = await instructorClient
      .from('material_chapters').select('id').eq('id', chapterId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('enrolled student can see chapters', async () => {
    const { data, error } = await studentClient
      .from('material_chapters').select('id').eq('id', chapterId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('unenrolled student cannot see chapters', async () => {
    const { data, error } = await unenrolledClient
      .from('material_chapters').select('id').eq('id', chapterId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot insert chapters', async () => {
    const { error } = await studentClient
      .from('material_chapters')
      .insert({ material_id: materialId, title: 'Blocked', chapter_number: 99, content_type: 'text' });
    expect(error).not.toBeNull();
  });
});
