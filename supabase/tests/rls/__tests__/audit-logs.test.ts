// Tables under test: public.audit_logs
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260725064858_audit_logs.sql
//       - CREATE TABLE audit_logs, RLS policies
//         "Super admins can read all audit logs",
//         "Institution admins can read their institution audit logs",
//         and the deliberate ABSENCE of any INSERT/UPDATE/DELETE policy
//         (service-role writes only, via _shared/audit.ts).
//
// Erasure-safety of the delete-user metadata is enforced in the edge function,
// not by RLS, so it is out of scope for this policy test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  addUserToInstitution,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

async function seedAuditLog(
  admin: SupabaseClient,
  row: {
    action: string;
    institutionId: string | null;
    actorUserId?: string | null;
    targetUserId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const { data, error } = await admin
    .from('audit_logs')
    .insert({
      action: row.action,
      institution_id: row.institutionId,
      actor_user_id: row.actorUserId ?? null,
      target_user_id: row.targetUserId ?? null,
      metadata: row.metadata ?? {},
    })
    .select('id')
    .single();
  if (error) throw new Error(`seedAuditLog: ${error.message}`);
  return data.id;
}

describe('audit_logs RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;

  let ownRowId: string;
  let otherRowId: string;
  let globalRowId: string; // institution_id IS NULL

  let adminClient: SupabaseClient;
  let superAdminClient: SupabaseClient;
  let otherInstAdminClient: SupabaseClient;
  let studentClient: SupabaseClient;

  const userIds: string[] = [];
  const superAdminEmail = `rls-audit-sa-${uid}@test.local`;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Audit ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS Audit Other ${uid}`);

    const adm = await createTestUserClient(admin, `rls-audit-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    const otherAdm = await createTestUserClient(admin, `rls-audit-otheradm-${uid}@test.local`);
    otherInstAdminClient = otherAdm.client; userIds.push(otherAdm.userId);
    await addUserToInstitution(admin, otherAdm.userId, otherInstitutionId, 'admin');

    const stu = await createTestUserClient(admin, `rls-audit-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');

    ownRowId = await seedAuditLog(admin, {
      action: 'user.create',
      institutionId,
      metadata: { role: 'student' },
    });
    otherRowId = await seedAuditLog(admin, {
      action: 'user.delete',
      institutionId: otherInstitutionId,
      metadata: { roles: ['student'] },
    });
    globalRowId = await seedAuditLog(admin, {
      action: 'data.export',
      institutionId: null,
      metadata: { table_count: 3 },
    });
  });

  afterAll(async () => {
    await admin.from('audit_logs').delete().in('id', [ownRowId, otherRowId, globalRowId]);
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await admin.from('user_institutions').delete().eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // SELECT — super-admin sees everything
  it('super-admin can read an institution-scoped row', async () => {
    const { data, error } = await superAdminClient
      .from('audit_logs').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super-admin can read a row from another institution', async () => {
    const { data, error } = await superAdminClient
      .from('audit_logs').select('id').eq('id', otherRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super-admin can read a global (null-institution) row', async () => {
    const { data, error } = await superAdminClient
      .from('audit_logs').select('id').eq('id', globalRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // SELECT — institution admin scoped to their institution only
  it('institution admin can read a row scoped to their institution', async () => {
    const { data, error } = await adminClient
      .from('audit_logs').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('institution admin cannot read a row from another institution', async () => {
    const { data, error } = await adminClient
      .from('audit_logs').select('id').eq('id', otherRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin cannot read a global (null-institution) row', async () => {
    const { data, error } = await adminClient
      .from('audit_logs').select('id').eq('id', globalRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin from a different institution cannot read this institution\'s row', async () => {
    const { data, error } = await otherInstAdminClient
      .from('audit_logs').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // SELECT — non-admins see nothing
  it('a student cannot read any audit row', async () => {
    const { data, error } = await studentClient
      .from('audit_logs').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // INSERT — no client policy, so all direct inserts are rejected
  it('institution admin cannot insert an audit row', async () => {
    const { error } = await adminClient
      .from('audit_logs')
      .insert({ action: 'user.create', institution_id: institutionId });
    expect(error).not.toBeNull();
  });

  it('super-admin cannot insert an audit row (writes are service-role only)', async () => {
    const { error } = await superAdminClient
      .from('audit_logs')
      .insert({ action: 'user.create', institution_id: institutionId });
    expect(error).not.toBeNull();
  });

  // UPDATE — no client policy, so no rows are ever matched for update
  it('institution admin cannot update an audit row they can read', async () => {
    const { data } = await adminClient
      .from('audit_logs')
      .update({ metadata: { tampered: true } })
      .eq('id', ownRowId)
      .select();
    expect(data ?? []).toHaveLength(0);
    // Confirm the row is untouched via the service-role client.
    const { data: check } = await admin
      .from('audit_logs').select('metadata').eq('id', ownRowId).single();
    expect((check?.metadata as Record<string, unknown>)?.tampered).toBeUndefined();
  });

  it('super-admin cannot update an audit row', async () => {
    const { data } = await superAdminClient
      .from('audit_logs')
      .update({ metadata: { tampered: true } })
      .eq('id', ownRowId)
      .select();
    expect(data ?? []).toHaveLength(0);
  });

  // DELETE — no client policy, so no rows are ever matched for delete
  it('institution admin cannot delete an audit row they can read', async () => {
    const { data } = await adminClient
      .from('audit_logs').delete().eq('id', ownRowId).select();
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin
      .from('audit_logs').select('id').eq('id', ownRowId);
    expect(check).toHaveLength(1);
  });

  it('super-admin cannot delete an audit row', async () => {
    const { data } = await superAdminClient
      .from('audit_logs').delete().eq('id', ownRowId).select();
    expect(data ?? []).toHaveLength(0);
  });
});
