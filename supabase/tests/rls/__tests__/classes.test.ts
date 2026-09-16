import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createClass,
  addUserToInstitution,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('classes RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;
  let classId: string;

  let adminClient: SupabaseClient;
  let instructorClient: SupabaseClient;
  let studentClient: SupabaseClient;
  let outsiderClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Classes ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS Classes Other ${uid}`);
    classId = await createClass(admin, institutionId);

    const adm = await createTestUserClient(admin, `rls-cls-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const inst = await createTestUserClient(admin, `rls-cls-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    // No class enrolment for instructors: 20260403000000 added
    // chk_student_enrollments_only and moved instructor assignment to
    // course_instructors. Institution membership is what gates `classes`.
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');

    const stu = await createTestUserClient(admin, `rls-cls-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const out = await createTestUserClient(admin, `rls-cls-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, otherInstitutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  it('institution member can see classes', async () => {
    const { data, error } = await studentClient
      .from('classes').select('id').eq('id', classId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('institution instructor can see classes without being enrolled', async () => {
    const { data, error } = await instructorClient
      .from('classes').select('id').eq('id', classId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('outsider cannot see classes from other institution', async () => {
    const { data, error } = await outsiderClient
      .from('classes').select('id').eq('id', classId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin can insert a class', async () => {
    const { data, error } = await adminClient
      .from('classes')
      .insert({ institution_id: institutionId, name: `Admin Class ${uid}`, is_active: true })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot insert a class', async () => {
    const { error } = await studentClient
      .from('classes')
      .insert({ institution_id: institutionId, name: 'Blocked', is_active: true });
    expect(error).not.toBeNull();
  });

  it('student cannot delete a class', async () => {
    const { data } = await studentClient
      .from('classes').delete().eq('id', classId).select();
    expect(data).toHaveLength(0);
  });
});
