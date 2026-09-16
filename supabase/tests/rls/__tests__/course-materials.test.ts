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

describe('course_materials RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let materialId: string;

  let adminClient: SupabaseClient;
  let instructorClient: SupabaseClient;
  let studentClient: SupabaseClient;
  let unenrolledClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Materials ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    materialId = await createCourseMaterial(admin, courseId);

    const adm = await createTestUserClient(admin, `rls-mat-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const inst = await createTestUserClient(admin, `rls-mat-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const stu = await createTestUserClient(admin, `rls-mat-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const unenr = await createTestUserClient(admin, `rls-mat-unenr-${uid}@test.local`);
    unenrolledClient = unenr.client; userIds.push(unenr.userId);
    await addUserToInstitution(admin, unenr.userId, institutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('admin can see course materials', async () => {
    const { data, error } = await adminClient
      .from('course_materials').select('id').eq('id', materialId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('assigned instructor can see course materials', async () => {
    const { data, error } = await instructorClient
      .from('course_materials').select('id').eq('id', materialId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('enrolled student can see course materials', async () => {
    const { data, error } = await studentClient
      .from('course_materials').select('id').eq('id', materialId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('unenrolled student cannot see course materials', async () => {
    const { data, error } = await unenrolledClient
      .from('course_materials').select('id').eq('id', materialId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot insert course materials', async () => {
    const { error } = await studentClient
      .from('course_materials')
      .insert({ course_id: courseId, file_name: 'blocked.pdf', file_url: 'https://blocked' });
    expect(error).not.toBeNull();
  });

  it('student cannot delete course materials', async () => {
    const { data } = await studentClient
      .from('course_materials').delete().eq('id', materialId).select();
    expect(data).toHaveLength(0);
  });

  // #1019 — "a chapterless material never has chapters", enforced by triggers
  // rather than by the client, because a count followed by a separate update is
  // not atomic. These run as the service role: triggers fire for it too, so
  // they pin the invariant itself rather than any particular caller's path.
  describe('chapterless material invariant', () => {
    it('rejects reclassifying a material that has chapters as "other"', async () => {
      const withChapters = await createCourseMaterial(admin, courseId);
      await createMaterialChapter(admin, withChapters);

      const { error } = await admin
        .from('course_materials')
        .update({ material_type: 'other' })
        .eq('id', withChapters);

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/never split into chapters/i);
    });

    it('rejects the same move to "images"', async () => {
      const withChapters = await createCourseMaterial(admin, courseId);
      await createMaterialChapter(admin, withChapters);

      const { error } = await admin
        .from('course_materials')
        .update({ material_type: 'images' })
        .eq('id', withChapters);

      expect(error).not.toBeNull();
    });

    it('rejects adding a chapter to a material that is already "other"', async () => {
      const other = await createCourseMaterial(admin, courseId);
      const { error: typeError } = await admin
        .from('course_materials')
        .update({ material_type: 'other' })
        .eq('id', other);
      expect(typeError).toBeNull();

      const { error } = await admin
        .from('material_chapters')
        .insert({
          material_id: other,
          title: 'Blocked chapter',
          chapter_number: 1,
          content_type: 'text',
        });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/never split into chapters/i);
    });

    it('allows reclassifying a material that has no chapters', async () => {
      const bare = await createCourseMaterial(admin, courseId);

      const { error } = await admin
        .from('course_materials')
        .update({ material_type: 'other' })
        .eq('id', bare);

      expect(error).toBeNull();
    });

    it('allows editing other columns on a chaptered material, and moving back out', async () => {
      const withChapters = await createCourseMaterial(admin, courseId);
      await createMaterialChapter(admin, withChapters);

      // The trigger keys on an actual type change, so unrelated edits pass.
      const { error: titleError } = await admin
        .from('course_materials')
        .update({ title: 'Renamed' })
        .eq('id', withChapters);
      expect(titleError).toBeNull();

      // Moving to another chaptered type strands nothing.
      const { error: typeError } = await admin
        .from('course_materials')
        .update({ material_type: 'teacher_companion' })
        .eq('id', withChapters);
      expect(typeError).toBeNull();
    });
  });
});
