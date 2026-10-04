// Tables under test: public.user_institutions -> public.audit_logs
//
// Migration: 20261004120000_audit_institution_role_changes.sql
//   - trigger audit_user_institution_change records user.role_change,
//     user.suspend and user.reactivate for every write to user_institutions,
//     including the browser-direct writes UserManagement.tsx makes.
//
// The writes below go through the institution admin's own client, exactly as
// the SPA issues them, so the assertion is that a PostgREST write with no edge
// function in the path still leaves a trace naming the admin.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  actor_email: string | null;
  target_user_id: string | null;
  institution_id: string | null;
  metadata: Record<string, unknown>;
}

describe('user_institutions writes are audited', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);
  const adminEmail = `rls-roleaudit-adm-${uid}@test.local`;

  let institutionId: string;
  let adminClient: SupabaseClient;
  let adminUserId: string;
  let memberId: string;
  const userIds: string[] = [];

  async function auditRowsFor(targetUserId: string): Promise<AuditRow[]> {
    const { data, error } = await admin
      .from('audit_logs')
      .select('action, actor_user_id, actor_email, target_user_id, institution_id, metadata')
      .eq('target_user_id', targetUserId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data as AuditRow[];
  }

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Role Audit ${uid}`);

    const adm = await createTestUserClient(admin, adminEmail, 'testpass123', { aal2: true });
    adminClient = adm.client; adminUserId = adm.userId; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const member = await createTestUserClient(admin, `rls-roleaudit-mem-${uid}@test.local`);
    memberId = member.userId; userIds.push(member.userId);
    await addUserToInstitution(admin, member.userId, institutionId, 'instructor');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    // After cleanup: its membership deletes are audited too.
    await admin.from('audit_logs').delete().in('target_user_id', userIds);
  });

  it('records a service-role grant with no actor', async () => {
    const rows = await auditRowsFor(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user.role_change',
      actor_user_id: null,
      institution_id: institutionId,
      metadata: { from_role: null, to_role: 'instructor', via: 'service_role' },
    });
  });

  it('records a browser-direct promotion to admin, naming the admin who did it', async () => {
    const { error } = await adminClient
      .from('user_institutions')
      .update({ role: 'admin' })
      .eq('user_id', memberId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();

    const rows = await auditRowsFor(memberId);
    expect(rows.at(-1)).toMatchObject({
      action: 'user.role_change',
      actor_user_id: adminUserId,
      actor_email: adminEmail,
      institution_id: institutionId,
      metadata: { from_role: 'instructor', to_role: 'admin', via: 'authenticated' },
    });
  });

  it('the acting admin can read the row back', async () => {
    const { data, error } = await adminClient
      .from('audit_logs')
      .select('action')
      .eq('target_user_id', memberId)
      .eq('action', 'user.role_change');
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  it('does not record an update that leaves role and suspension unchanged', async () => {
    const before = (await auditRowsFor(memberId)).length;
    const { error } = await adminClient
      .from('user_institutions')
      .update({ role: 'admin' })
      .eq('user_id', memberId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(await auditRowsFor(memberId)).toHaveLength(before);
  });

  it('records suspension and reactivation', async () => {
    for (const is_suspended of [true, false]) {
      const { error } = await adminClient
        .from('user_institutions')
        .update({ is_suspended })
        .eq('user_id', memberId)
        .eq('institution_id', institutionId);
      expect(error).toBeNull();
    }
    const actions = (await auditRowsFor(memberId)).slice(-2);
    expect(actions.map((r) => r.action)).toEqual(['user.suspend', 'user.reactivate']);
    expect(actions.every((r) => r.actor_user_id === adminUserId)).toBe(true);
  });

  it('records a removal as a revocation of the role', async () => {
    const { error } = await adminClient
      .from('user_institutions')
      .delete()
      .eq('user_id', memberId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();

    const rows = await auditRowsFor(memberId);
    expect(rows.at(-1)).toMatchObject({
      action: 'user.role_change',
      actor_user_id: adminUserId,
      metadata: { from_role: 'admin', to_role: null },
    });
  });
});
