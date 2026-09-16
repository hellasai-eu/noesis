// Tables / objects under test:
//   * storage.objects (bucket 'content-images')
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260831090000_content_images_bucket.sql
//       - 'content-images' bucket (public) + policies:
//           "Authors can upload their own content images"
//           "Anyone can view content images"
//           "Authors can delete their own content images"
//
// Notes:
//   * Uploads go straight from the browser via
//     supabase.storage.from('content-images').upload() in
//     src/lib/editor-images.ts, so this storage RLS IS the boundary — there is
//     no edge function in front of it.
//   * The bucket is deliberately PUBLIC on read: its URLs are baked into
//     `theory_html` and have to keep resolving long after the session that
//     wrote them is gone. What must stay closed is WRITE. The read tests below
//     pin the openness as a decision rather than leave it as an accident.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

const BUCKET = 'content-images';

function tinyPng(): Uint8Array {
  // 1x1 transparent PNG — enough payload to exercise the upload path.
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

describe('content-images storage RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;

  let instructorClient: SupabaseClient;
  let instructorId: string;
  let adminClient: SupabaseClient;
  let adminId: string;
  let studentClient: SupabaseClient;
  let studentId: string;

  const userIds: string[] = [];
  const uploadedPaths: string[] = [];

  // An image the instructor already attached, for the read/delete cases.
  let seedPath: string;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Content Images ${uid}`);

    const inst = await createTestUserClient(admin, `rls-img-inst-${uid}@test.local`);
    instructorClient = inst.client;
    instructorId = inst.userId;
    userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');

    const adm = await createTestUserClient(admin, `rls-img-adm-${uid}@test.local`);
    adminClient = adm.client;
    adminId = adm.userId;
    userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const stu = await createTestUserClient(admin, `rls-img-stu-${uid}@test.local`);
    studentClient = stu.client;
    studentId = stu.userId;
    userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');

    seedPath = `${instructorId}/${crypto.randomUUID()}-seed.png`;
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(seedPath, fileBlob(), { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`seed upload: ${error.message}`);
    uploadedPaths.push(seedPath);
  });

  afterAll(async () => {
    if (uploadedPaths.length > 0) {
      await admin.storage.from(BUCKET).remove(uploadedPaths);
    }
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ============================================================
  // INSERT — the boundary that matters
  // ============================================================

  it('instructor can upload under their own user-id prefix', async () => {
    const path = `${instructorId}/${crypto.randomUUID()}-ok.png`;
    const { error } = await instructorClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).toBeNull();
    uploadedPaths.push(path);
  });

  it('institution admin can upload under their own user-id prefix', async () => {
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

  it('student cannot upload even under their own prefix — students do not author', async () => {
    const path = `${studentId}/${crypto.randomUUID()}-blocked.png`;
    const { error } = await studentClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();
  });

  it('a suspended instructor cannot upload', async () => {
    // Suspension switches a membership off without deleting it. An instructor
    // who can still publish into a public bucket while suspended is not really
    // suspended.
    const suspended = await createTestUserClient(admin, `rls-img-susp-${uid}@test.local`);
    userIds.push(suspended.userId);
    await addUserToInstitution(admin, suspended.userId, institutionId, 'instructor');

    // Allowed while active — the control for the assertion below.
    const okPath = `${suspended.userId}/${crypto.randomUUID()}-while-active.png`;
    const { error: activeErr } = await suspended.client.storage
      .from(BUCKET)
      .upload(okPath, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(activeErr).toBeNull();
    uploadedPaths.push(okPath);

    const { error: suspendErr } = await admin
      .from('user_institutions')
      .update({ is_suspended: true })
      .eq('user_id', suspended.userId)
      .eq('institution_id', institutionId);
    expect(suspendErr).toBeNull();

    const blockedPath = `${suspended.userId}/${crypto.randomUUID()}-while-suspended.png`;
    const { error } = await suspended.client.storage
      .from(BUCKET)
      .upload(blockedPath, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(error).not.toBeNull();

    // ...and they cannot delete what they uploaded before the suspension.
    await suspended.client.storage.from(BUCKET).remove([okPath]);
    const { data: still } = await admin.storage
      .from(BUCKET)
      .list(suspended.userId, { search: okPath.split('/')[1] });
    expect(still?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  // ============================================================
  // SELECT — open on purpose
  // ============================================================

  it('a student can read an image an instructor attached', async () => {
    // This is the whole point of the bucket: the <img> in a study guide has to
    // load for the student reading it.
    const { data, error } = await studentClient.storage.from(BUCKET).download(seedPath);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  // ============================================================
  // DELETE
  // ============================================================

  it('an author cannot delete another author’s image', async () => {
    await adminClient.storage.from(BUCKET).remove([seedPath]);
    // remove() can resolve without throwing but delete nothing — what is
    // asserted is that the object survived.
    const { data } = await admin.storage
      .from(BUCKET)
      .list(instructorId, { search: seedPath.split('/')[1] });
    expect(data?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('a demoted author cannot delete the image they uploaded as an author', async () => {
    // The uid is permanent; authorship is not. An instructor who is demoted to
    // student still owns the prefix their old uploads sit under — and those
    // images are load-bearing in study guides still being taught from.
    const demoted = await createTestUserClient(admin, `rls-img-demoted-${uid}@test.local`);
    userIds.push(demoted.userId);
    await addUserToInstitution(admin, demoted.userId, institutionId, 'instructor');

    const path = `${demoted.userId}/${crypto.randomUUID()}-authored.png`;
    const { error: upErr } = await demoted.client.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(upErr).toBeNull();
    uploadedPaths.push(path);

    // ...and now they are a student.
    const { error: demoteErr } = await admin
      .from('user_institutions')
      .update({ role: 'student' })
      .eq('user_id', demoted.userId)
      .eq('institution_id', institutionId);
    expect(demoteErr).toBeNull();

    // remove() may resolve without throwing but delete nothing — what matters
    // is that the object is still there afterwards.
    await demoted.client.storage.from(BUCKET).remove([path]);

    const { data: still } = await admin.storage
      .from(BUCKET)
      .list(demoted.userId, { search: path.split('/')[1] });
    expect(still?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('an author can delete their own image', async () => {
    const path = `${instructorId}/${crypto.randomUUID()}-todelete.png`;
    const { error: upErr } = await instructorClient.storage
      .from(BUCKET)
      .upload(path, fileBlob(), { contentType: 'image/png', upsert: false });
    expect(upErr).toBeNull();

    const { error } = await instructorClient.storage.from(BUCKET).remove([path]);
    expect(error).toBeNull();

    const { data } = await admin.storage
      .from(BUCKET)
      .list(instructorId, { search: path.split('/')[1] });
    expect(data?.length ?? 0).toBe(0);
  });
});
