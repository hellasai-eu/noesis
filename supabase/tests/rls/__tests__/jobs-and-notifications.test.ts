// Tables / objects under test:
//   * public.jobs
//   * public.job_items
//   * public.notifications
//
// Migration that introduced the policies covered here:
//   * 20260626100000_jobs_and_notifications.sql (issue #694, epic #693)
//
// Policy shape:
//   * jobs / job_items: SELECT-only for end users — visible to the creator,
//     to course instructors of the scoped course, to institution admins of
//     the scoping institution, and to super-admins. NO end-user writes; the
//     runner (#695) writes via the service role.
//   * notifications: SELECT + UPDATE for the owner (mark-as-read). Inserts
//     happen via service role (notify-on-complete in #695).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  addUserToInstitution,
  assignCourseInstructor,
  addSuperAdmin,
  createJob,
  createJobItem,
  createNotification,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('jobs + job_items + notifications RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  // Institution A holds the bulk of the scaffolding. Institution B exists
  // solely to exercise institutional isolation.
  let institutionA: string;
  let institutionB: string;
  let courseA: string;

  let creatorClient: SupabaseClient;
  let creatorId: string;
  let instructorClient: SupabaseClient;
  let instructorId: string;
  let instAdminClient: SupabaseClient;
  let instAdminId: string;
  let outsiderSameInstClient: SupabaseClient;
  let outsiderSameInstId: string;
  let outsiderOtherInstClient: SupabaseClient;
  let outsiderOtherInstId: string;
  let superAdminClient: SupabaseClient;
  let superAdminId: string;

  const userIds: string[] = [];
  const superAdminEmail = `rls-jobs-sa-${uid}@test.local`;

  // Seed rows used across tests.
  let jobId: string;
  let jobItemId: string;
  let notificationForCreatorId: string;

  beforeAll(async () => {
    institutionA = await createInstitution(admin, `RLS Jobs A ${uid}`);
    institutionB = await createInstitution(admin, `RLS Jobs B ${uid}`);

    const creator = await createTestUserClient(admin, `rls-jobs-creator-${uid}@test.local`);
    creatorClient = creator.client; creatorId = creator.userId; userIds.push(creator.userId);
    await addUserToInstitution(admin, creator.userId, institutionA, 'instructor');

    const inst = await createTestUserClient(admin, `rls-jobs-inst-${uid}@test.local`);
    instructorClient = inst.client; instructorId = inst.userId; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionA, 'instructor');

    const ia = await createTestUserClient(admin, `rls-jobs-ia-${uid}@test.local`);
    instAdminClient = ia.client; instAdminId = ia.userId; userIds.push(ia.userId);
    await addUserToInstitution(admin, ia.userId, institutionA, 'admin');

    const outsider = await createTestUserClient(admin, `rls-jobs-out-${uid}@test.local`);
    outsiderSameInstClient = outsider.client; outsiderSameInstId = outsider.userId; userIds.push(outsider.userId);
    await addUserToInstitution(admin, outsider.userId, institutionA, 'student');

    const otherInst = await createTestUserClient(admin, `rls-jobs-other-${uid}@test.local`);
    outsiderOtherInstClient = otherInst.client; outsiderOtherInstId = otherInst.userId; userIds.push(otherInst.userId);
    await addUserToInstitution(admin, otherInst.userId, institutionB, 'instructor');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; superAdminId = sa.userId; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    // The scoped course lives in institution A and is taught by `instructor`.
    courseA = await createCourse(admin, institutionA, creatorId);
    await assignCourseInstructor(admin, courseA, instructorId);

    // Seed job + item + notification (service role bypasses RLS).
    jobId = await createJob(admin, {
      institutionId: institutionA,
      createdBy: creatorId,
      courseId: courseA,
      type: 'rls_test_job',
    });
    jobItemId = await createJobItem(admin, jobId, `unit-${uid}`);
    notificationForCreatorId = await createNotification(admin, creatorId, {
      jobId,
      type: 'job_completed',
      title: `Seed notification ${uid}`,
    });

    // Suppress lint warnings for ids referenced only for cleanup / clarity.
    void instAdminId;
    void outsiderSameInstId;
    void outsiderOtherInstId;
    void superAdminId;
    void jobItemId;
  });

  afterAll(async () => {
    // Notifications & jobs cascade via ON DELETE CASCADE on user_id /
    // institution_id when the institutions and users are torn down.
    await cleanupScaffold(admin, { institutionId: institutionA, userIds });
    await cleanupScaffold(admin, { institutionId: institutionB, userIds: [] });
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
  });

  // ============================================================
  // notifications: owner-sees-own (AC: "user sees their own notifications")
  // ============================================================

  it('owner can read their own notification', async () => {
    const { data, error } = await creatorClient
      .from('notifications' as never)
      .select('id')
      .eq('id', notificationForCreatorId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('another user cannot read someone else’s notification', async () => {
    const { data, error } = await instructorClient
      .from('notifications' as never)
      .select('id')
      .eq('id', notificationForCreatorId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin cannot read another user’s notification', async () => {
    const { data, error } = await instAdminClient
      .from('notifications' as never)
      .select('id')
      .eq('id', notificationForCreatorId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('owner can mark their own notification as read', async () => {
    const { data, error } = await creatorClient
      .from('notifications' as never)
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationForCreatorId)
      .select('id, read_at');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as Array<{ read_at: string | null }>)[0].read_at).not.toBeNull();
  });

  it('another user cannot mark someone else’s notification as read', async () => {
    const { data } = await instructorClient
      .from('notifications' as never)
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationForCreatorId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('end user cannot insert a notification directly (service-role only)', async () => {
    const { error } = await creatorClient
      .from('notifications' as never)
      .insert({
        user_id: creatorId,
        type: 'job_completed',
        title: 'Spoofed',
      });
    expect(error).not.toBeNull();
  });

  // ============================================================
  // jobs: course-manager-sees-job (AC: "course managers see scoped jobs")
  // ============================================================

  it('creator sees their own job', async () => {
    const { data, error } = await creatorClient
      .from('jobs' as never)
      .select('id')
      .eq('id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('course instructor of the scoped course sees the job', async () => {
    const { data, error } = await instructorClient
      .from('jobs' as never)
      .select('id')
      .eq('id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('institution admin of the scoping institution sees the job', async () => {
    const { data, error } = await instAdminClient
      .from('jobs' as never)
      .select('id')
      .eq('id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super-admin sees all jobs', async () => {
    const { data, error } = await superAdminClient
      .from('jobs' as never)
      .select('id')
      .eq('id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('unrelated user in the same institution does NOT see the job', async () => {
    const { data, error } = await outsiderSameInstClient
      .from('jobs' as never)
      .select('id')
      .eq('id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('user in a different institution does NOT see the job', async () => {
    const { data, error } = await outsiderOtherInstClient
      .from('jobs' as never)
      .select('id')
      .eq('id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('end user cannot insert a job directly (service-role only)', async () => {
    const { error } = await creatorClient
      .from('jobs' as never)
      .insert({
        type: 'rls_test_job',
        status: 'pending',
        created_by: creatorId,
        institution_id: institutionA,
        course_id: courseA,
      });
    expect(error).not.toBeNull();
  });

  it('end user cannot update a job directly (service-role only)', async () => {
    const { data } = await creatorClient
      .from('jobs' as never)
      .update({ status: 'cancelled' })
      .eq('id', jobId)
      .select();
    expect(data).toHaveLength(0);
  });

  // ============================================================
  // job_items: visibility derives from the parent job
  // ============================================================

  it('creator of the parent job sees its items', async () => {
    const { data, error } = await creatorClient
      .from('job_items' as never)
      .select('id')
      .eq('job_id', jobId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });

  it('course instructor of the scoped course sees the job items', async () => {
    const { data, error } = await instructorClient
      .from('job_items' as never)
      .select('id')
      .eq('job_id', jobId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });

  it('user in a different institution does NOT see the job items', async () => {
    const { data, error } = await outsiderOtherInstClient
      .from('job_items' as never)
      .select('id')
      .eq('job_id', jobId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('end user cannot insert a job item directly (service-role only)', async () => {
    const { error } = await creatorClient
      .from('job_items' as never)
      .insert({
        job_id: jobId,
        item_key: `spoof-${uid}`,
        status: 'pending',
      });
    expect(error).not.toBeNull();
  });
});
