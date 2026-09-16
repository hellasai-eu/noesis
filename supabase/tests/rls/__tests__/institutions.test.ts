import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  addUserToInstitution,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('institutions RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;

  let superadminClient: SupabaseClient;
  let adminClient: SupabaseClient;
  let memberClient: SupabaseClient;
  let outsiderClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Inst ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS Inst Other ${uid}`);

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, `rls-sa-inst-${uid}@test.local`, 'testpass123', {
      aal2: true,
    });
    superadminClient = sa.client; userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'admin');
    await addSuperAdmin(admin, `rls-sa-inst-${uid}@test.local`);

    const adm = await createTestUserClient(admin, `rls-adm-inst-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const mem = await createTestUserClient(admin, `rls-mem-inst-${uid}@test.local`);
    memberClient = mem.client; userIds.push(mem.userId);
    await addUserToInstitution(admin, mem.userId, institutionId, 'student');

    const out = await createTestUserClient(admin, `rls-out-inst-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, otherInstitutionId, 'student');
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', `rls-sa-inst-${uid}@test.local`);
    await cleanupScaffold(admin, { institutionId, userIds });
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  // SELECT
  it('member can see their own institution', async () => {
    const { data, error } = await memberClient
      .from('institutions').select('id').eq('id', institutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('member cannot see other institution', async () => {
    const { data, error } = await memberClient
      .from('institutions').select('id').eq('id', otherInstitutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('super admin can see all institutions', async () => {
    const { data, error } = await superadminClient
      .from('institutions').select('id').in('id', [institutionId, otherInstitutionId]);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  // UPDATE
  it('admin can update their institution', async () => {
    const { error } = await adminClient
      .from('institutions').update({ name: `Updated ${uid}` }).eq('id', institutionId);
    expect(error).toBeNull();
  });

  it('member (student) cannot update institution', async () => {
    const { data, error } = await memberClient
      .from('institutions').update({ name: 'Hacked' }).eq('id', institutionId).select();
    // RLS silently returns 0 rows when update is denied
    expect(data).toHaveLength(0);
  });

  // openai_store_enabled — super-admin-only column. RLS lets an institution
  // admin UPDATE their own row, so this column is guarded by a trigger
  // (trg_guard_openai_store_enabled) rather than by a policy.
  it('institution admin cannot change OpenAI data retention', async () => {
    const { error } = await adminClient
      .from('institutions')
      .update({ openai_store_enabled: true })
      .eq('id', institutionId);
    expect(error).not.toBeNull();

    const { data } = await admin
      .from('institutions')
      .select('openai_store_enabled')
      .eq('id', institutionId)
      .single();
    expect(data!.openai_store_enabled).toBe(false);
  });

  it('super admin can toggle OpenAI data retention', async () => {
    const { error } = await superadminClient
      .from('institutions')
      .update({ openai_store_enabled: true })
      .eq('id', institutionId);
    expect(error).toBeNull();

    const { data } = await admin
      .from('institutions')
      .select('openai_store_enabled')
      .eq('id', institutionId)
      .single();
    expect(data!.openai_store_enabled).toBe(true);

    // Restore the default so later tests read the flag as a fresh row would.
    await admin.from('institutions').update({ openai_store_enabled: false }).eq('id', institutionId);
  });

  // ai_features_disabled — school-controlled column (20260913160000), the
  // deliberate opposite of openai_store_enabled: the institution's own admin
  // writes it, students cannot, and a CHECK keeps it a subset of the known
  // families.
  it('institution admin can switch an AI family off and on', async () => {
    const { error } = await adminClient
      .from('institutions')
      .update({ ai_features_disabled: ['tutoring'] })
      .eq('id', institutionId);
    expect(error).toBeNull();

    const { data } = await admin
      .from('institutions')
      .select('ai_features_disabled')
      .eq('id', institutionId)
      .single();
    expect(data!.ai_features_disabled).toEqual(['tutoring']);

    await adminClient
      .from('institutions')
      .update({ ai_features_disabled: [] })
      .eq('id', institutionId);
  });

  it('member (student) cannot change AI feature toggles', async () => {
    const { data } = await memberClient
      .from('institutions')
      .update({ ai_features_disabled: ['grading'] })
      .eq('id', institutionId)
      .select();
    // RLS silently returns 0 rows when update is denied
    expect(data).toHaveLength(0);
  });

  it('unknown family values are rejected by the CHECK constraint', async () => {
    const { error } = await adminClient
      .from('institutions')
      .update({ ai_features_disabled: ['moderation'] })
      .eq('id', institutionId);
    expect(error).not.toBeNull();
  });

  // The INSERT policy accepts any authenticated caller (20260104065140), so
  // the same trigger must also stop retention being pre-enabled at creation.
  it('non-super-admin cannot create an institution with retention pre-enabled', async () => {
    const slug = `rls-store-bypass-${uid}`;
    const { error } = await adminClient
      .from('institutions')
      .insert({ name: 'Store Bypass', slug, openai_store_enabled: true })
      .select('id')
      .single();
    expect(error).not.toBeNull();

    const { data } = await admin.from('institutions').select('id').eq('slug', slug);
    expect(data).toHaveLength(0);
  });

  it('super admin can create an institution with retention enabled', async () => {
    const slug = `rls-store-sa-${uid}-${crypto.randomUUID().slice(0, 4)}`;
    const { data, error } = await superadminClient
      .from('institutions')
      .insert({ name: `Store SA ${uid}`, slug, openai_store_enabled: true })
      .select('id, openai_store_enabled')
      .single();
    expect(error).toBeNull();
    expect(data!.openai_store_enabled).toBe(true);
    if (data) await admin.from('institutions').delete().eq('id', data.id);
  });

  // INSERT
  it('super admin can insert institution', async () => {
    const slug = `rls-new-${uid}-${crypto.randomUUID().slice(0, 4)}`;
    const { data, error } = await superadminClient
      .from('institutions').insert({ name: `New ${uid}`, slug }).select('id').single();
    expect(error).toBeNull();
    // Cleanup
    if (data) await admin.from('institutions').delete().eq('id', data.id);
  });

  it('non-super-admin cannot insert institution', async () => {
    const slug = `rls-blocked-${uid}`;
    const { error } = await adminClient
      .from('institutions').insert({ name: 'Blocked', slug }).select('id').single();
    expect(error).not.toBeNull();
  });
});
