// Tables / objects under test:
//   * public.bug_reports
//   * storage.objects (bucket 'bug-reports')
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260604000000_bug_reports.sql
//       - CREATE TABLE bug_reports, RLS policies:
//           "Authenticated users can submit their own bug reports"
//           "Super admins can read/update/delete bug reports"
//       - 'bug-reports' storage bucket + policies:
//           "Authenticated users can upload their own bug screenshots"
//           "Super admins can read/delete bug screenshots"
//
// Notes:
//   * No edge function is involved — uploads go directly through
//     supabase.storage.from('bug-reports').upload() from the browser,
//     so the storage RLS in this file is the authoritative check.
//   * The INSERT policy on bug_reports gates on institution role
//     ('instructor' / 'admin') OR super-admin — students cannot file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution, addSuperAdmin } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

const BUCKET = 'bug-reports';

function tinyPng(): Uint8Array {
  // 1x1 transparent PNG — sufficient payload to exercise the upload path.
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

describe('bug_reports RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;

  let instructorClient: SupabaseClient;
  let instructorId: string;
  let adminClient: SupabaseClient;
  let adminId: string;
  let studentClient: SupabaseClient;
  let studentId: string;
  let superAdminClient: SupabaseClient;
  let superAdminId: string;

  const userIds: string[] = [];
  const superAdminEmail = `rls-bug-sa-${uid}@test.local`;

  // Track created rows + uploaded objects for cleanup.
  const createdReportIds: string[] = [];
  const uploadedPaths: string[] = [];

  // Seed: a report owned by the instructor + a screenshot under their path.
  let seedReportId: string;
  let seedScreenshotPath: string;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Bug Reports ${uid}`);

    const inst = await createTestUserClient(admin, `rls-bug-inst-${uid}@test.local`);
    instructorClient = inst.client;
    instructorId = inst.userId;
    userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');

    const adm = await createTestUserClient(admin, `rls-bug-adm-${uid}@test.local`);
    adminClient = adm.client;
    adminId = adm.userId;
    userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const stu = await createTestUserClient(admin, `rls-bug-stu-${uid}@test.local`);
    studentClient = stu.client;
    studentId = stu.userId;
    userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client;
    superAdminId = sa.userId;
    userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    // Seed a report (via service role — bypasses RLS) so SELECT/UPDATE/DELETE
    // tests have a stable row to operate on regardless of test ordering.
    seedScreenshotPath = `${instructorId}/${crypto.randomUUID()}-seed.png`;
    const { error: seedUploadError } = await admin.storage
      .from(BUCKET)
      .upload(seedScreenshotPath, fileBlob(), { contentType: 'image/png', upsert: false });
    if (seedUploadError) throw new Error(`seed upload: ${seedUploadError.message}`);
    uploadedPaths.push(seedScreenshotPath);

    const { data: seedRow, error: seedInsertError } = await admin
      .from('bug_reports' as never)
      .insert({
        reporter_id: instructorId,
        reporter_email: `rls-bug-inst-${uid}@test.local`,
        reporter_role: 'instructor',
        institution_id: institutionId,
        title: `Seed ${uid}`,
        description: 'Seeded by RLS test',
        screenshot_paths: [seedScreenshotPath],
      })
      .select('id')
      .single();
    if (seedInsertError) throw new Error(`seed insert: ${seedInsertError.message}`);
    seedReportId = (seedRow as { id: string }).id;
    createdReportIds.push(seedReportId);
  });

  afterAll(async () => {
    if (uploadedPaths.length > 0) {
      await admin.storage.from(BUCKET).remove(uploadedPaths);
    }
    if (createdReportIds.length > 0) {
      await admin.from('bug_reports' as never).delete().in('id', createdReportIds);
    }
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ============================================================
  // INSERT (bug_reports table)
  // ============================================================

  // NOTE: these inserts deliberately do NOT chain `.select()`. SELECT on
  // bug_reports is super-admin-only, and `INSERT ... RETURNING` needs the
  // SELECT policy to pass for the new row — so asking for the row back fails
  // with 42501 even though the insert itself is allowed. BugReportDialog.tsx
  // submits without RETURNING for exactly this reason; the tests mirror it and
  // verify the row landed with the service-role client instead.
  async function findReportIdByTitle(title: string): Promise<string | null> {
    const { data } = await admin
      .from('bug_reports' as never)
      .select('id')
      .eq('title', title)
      .maybeSingle();
    return data ? (data as { id: string }).id : null;
  }

  it('instructor can insert their own bug report', async () => {
    const title = `Instructor insert ${uid}`;
    const { error } = await instructorClient.from('bug_reports' as never).insert({
      reporter_id: instructorId,
      title,
      description: 'body',
    });
    expect(error).toBeNull();

    const id = await findReportIdByTitle(title);
    expect(id).not.toBeNull();
    if (id) createdReportIds.push(id);
  });

  it('admin can insert their own bug report', async () => {
    const title = `Admin insert ${uid}`;
    const { error } = await adminClient.from('bug_reports' as never).insert({
      reporter_id: adminId,
      title,
      description: 'body',
    });
    expect(error).toBeNull();

    const id = await findReportIdByTitle(title);
    expect(id).not.toBeNull();
    if (id) createdReportIds.push(id);
  });

  it('a non-super-admin reporter cannot read back the row they just inserted', async () => {
    const title = `Instructor no-returning ${uid}`;
    const { error: insertError } = await instructorClient
      .from('bug_reports' as never)
      .insert({ reporter_id: instructorId, title, description: 'body' });
    expect(insertError).toBeNull();

    const id = await findReportIdByTitle(title);
    if (id) createdReportIds.push(id);

    const { data } = await instructorClient
      .from('bug_reports' as never)
      .select('id')
      .eq('title', title);
    expect(data).toHaveLength(0);
  });

  it('super-admin can insert their own bug report', async () => {
    const { data, error } = await superAdminClient
      .from('bug_reports' as never)
      .insert({
        reporter_id: superAdminId,
        title: `Super-admin insert ${uid}`,
        description: 'body',
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    if (data) createdReportIds.push((data as { id: string }).id);
  });

  it('student cannot insert a bug report', async () => {
    const { error } = await studentClient
      .from('bug_reports' as never)
      .insert({
        reporter_id: studentId,
        title: `Student insert ${uid}`,
        description: 'body',
      });
    expect(error).not.toBeNull();
  });

  it('user cannot insert a report with someone else as reporter_id', async () => {
    const { error } = await instructorClient
      .from('bug_reports' as never)
      .insert({
        reporter_id: adminId, // impersonating the admin
        title: `Spoofed reporter ${uid}`,
        description: 'body',
      });
    expect(error).not.toBeNull();
  });

  // ============================================================
  // SELECT (bug_reports table)
  // ============================================================

  it('super-admin can read all bug reports', async () => {
    const { data, error } = await superAdminClient
      .from('bug_reports' as never)
      .select('id')
      .eq('id', seedReportId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('reporter cannot read their own bug report (super-admin-only SELECT)', async () => {
    const { data, error } = await instructorClient
      .from('bug_reports' as never)
      .select('id')
      .eq('id', seedReportId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin in same institution cannot read another user’s report', async () => {
    const { data, error } = await adminClient
      .from('bug_reports' as never)
      .select('id')
      .eq('id', seedReportId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot read any bug reports', async () => {
    const { data, error } = await studentClient
      .from('bug_reports' as never)
      .select('id')
      .eq('id', seedReportId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // ============================================================
  // UPDATE (bug_reports table)
  // ============================================================

  it('super-admin can update report status', async () => {
    const { data, error } = await superAdminClient
      .from('bug_reports' as never)
      .update({ status: 'in_progress' })
      .eq('id', seedReportId)
      .select('id, status');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as Array<{ status: string }>)[0].status).toBe('in_progress');
  });

  it('non-super-admin cannot update report status', async () => {
    const { data } = await adminClient
      .from('bug_reports' as never)
      .update({ status: 'resolved' })
      .eq('id', seedReportId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('reporter cannot update their own report status', async () => {
    const { data } = await instructorClient
      .from('bug_reports' as never)
      .update({ status: 'resolved' })
      .eq('id', seedReportId)
      .select();
    expect(data).toHaveLength(0);
  });

  // ============================================================
  // DELETE (bug_reports table)
  // ============================================================

  it('super-admin can delete a report', async () => {
    // Seed a throw-away row so we don't trash the shared seed.
    const { data: tmp, error: insErr } = await admin
      .from('bug_reports' as never)
      .insert({
        reporter_id: instructorId,
        title: `Delete target ${uid}`,
        description: 'body',
      })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const tmpId = (tmp as { id: string }).id;
    createdReportIds.push(tmpId);

    const { data, error } = await superAdminClient
      .from('bug_reports' as never)
      .delete()
      .eq('id', tmpId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-super-admin cannot delete a report', async () => {
    const { data } = await adminClient
      .from('bug_reports' as never)
      .delete()
      .eq('id', seedReportId)
      .select();
    expect(data).toHaveLength(0);
  });

  // ============================================================
  // Storage bucket: 'bug-reports'
  // ============================================================

  it('instructor can upload a screenshot under their own user-id prefix', async () => {
    const path = `${instructorId}/${crypto.randomUUID()}-ok.png`;
    const { error } = await instructorClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).toBeNull();
    uploadedPaths.push(path);
  });

  it('admin can upload a screenshot under their own user-id prefix', async () => {
    const path = `${adminId}/${crypto.randomUUID()}-ok.png`;
    const { error } = await adminClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).toBeNull();
    uploadedPaths.push(path);
  });

  it('instructor cannot upload under another user’s prefix', async () => {
    const path = `${adminId}/${crypto.randomUUID()}-spoof.png`;
    const { error } = await instructorClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();
  });

  it('student cannot upload a screenshot even under their own prefix', async () => {
    const path = `${studentId}/${crypto.randomUUID()}-blocked.png`;
    const { error } = await studentClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();
  });

  it('non-super-admin cannot read another user’s screenshot', async () => {
    // adminClient (institution admin, not super-admin) trying to read the
    // instructor's seed screenshot.
    const { data, error } = await adminClient.storage
      .from(BUCKET)
      .download(seedScreenshotPath);
    // Storage RLS returns either an error or a null body; treat both as denied.
    const denied = !!error || data === null;
    expect(denied).toBe(true);
  });

  it('super-admin can read any screenshot', async () => {
    const { data, error } = await superAdminClient.storage
      .from(BUCKET)
      .download(seedScreenshotPath);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('non-super-admin cannot delete another user’s screenshot', async () => {
    const { error } = await adminClient.storage
      .from(BUCKET)
      .remove([seedScreenshotPath]);
    // remove() may resolve without throwing but report no deletions —
    // either way, the seed object must still exist afterwards.
    const { data } = await admin.storage
      .from(BUCKET)
      .list(instructorId, { search: seedScreenshotPath.split('/')[1] });
    expect(data?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('super-admin can delete a screenshot', async () => {
    const path = `${instructorId}/${crypto.randomUUID()}-todelete.png`;
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(upErr).toBeNull();

    const { data, error } = await superAdminClient.storage
      .from(BUCKET)
      .remove([path]);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });
});
