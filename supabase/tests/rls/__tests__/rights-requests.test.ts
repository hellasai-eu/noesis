// Tables under test: public.rights_requests
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260913090000_rights_requests.sql
//       - CREATE TABLE rights_requests (GDPR Art. 12(3) register),
//         generated due_at, extension/resolution CHECK constraints,
//         maintain trigger (closure stamping, erasure label scrub),
//         RLS: institution admins + super admins only, no DELETE policy.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution, addSuperAdmin } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('rights_requests RLS + register semantics', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;

  let instAdminClient: SupabaseClient;
  let instAdminId: string;
  let otherInstAdminClient: SupabaseClient;
  let studentClient: SupabaseClient;
  let studentId: string;
  let superAdminClient: SupabaseClient;

  let requestId: string;

  const userIds: string[] = [];
  const superAdminEmail = `rls-rr-sa-${uid}@test.local`;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS RR ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS RR Other ${uid}`);

    const adm = await createTestUserClient(admin, `rls-rr-adm-${uid}@test.local`);
    instAdminClient = adm.client; instAdminId = adm.userId; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const otherAdm = await createTestUserClient(admin, `rls-rr-otheradm-${uid}@test.local`);
    otherInstAdminClient = otherAdm.client; userIds.push(otherAdm.userId);
    await addUserToInstitution(admin, otherAdm.userId, otherInstitutionId, 'admin');

    const stu = await createTestUserClient(admin, `rls-rr-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await admin.from('rights_requests').delete().eq('institution_id', institutionId);
    await admin.from('rights_requests').delete().eq('institution_id', otherInstitutionId);
    await admin.from('user_institutions').delete().eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ── INSERT ────────────────────────────────────────────────────────────

  it('institution admin records a request; the schema computes the one-month deadline', async () => {
    const { data, error } = await instAdminClient
      .from('rights_requests')
      .insert({
        institution_id: institutionId,
        subject_user_id: studentId,
        subject_label: `Parent of student ${uid}`,
        request_type: 'access',
        received_at: '2026-09-01',
        created_by: instAdminId,
      })
      .select('id, due_at, status')
      .single();

    expect(error).toBeNull();
    expect(data!.due_at).toBe('2026-10-01');
    expect(data!.status).toBe('open');
    requestId = data!.id;
  });

  it('rejects a row claiming someone else recorded it', async () => {
    const { error } = await instAdminClient.from('rights_requests').insert({
      institution_id: institutionId,
      subject_label: 'x',
      request_type: 'access',
      created_by: studentId, // not auth.uid()
    });
    expect(error).not.toBeNull();
  });

  it("rejects a request filed into another institution's register", async () => {
    const { error } = await instAdminClient.from('rights_requests').insert({
      institution_id: otherInstitutionId,
      subject_label: 'x',
      request_type: 'access',
      created_by: instAdminId,
    });
    expect(error).not.toBeNull();
  });

  it("rejects linking a subject account from another institution", async () => {
    // The linked subject must belong to the register's institution: a request
    // naming another school's student would surface in that subject's Art. 15
    // export attributed to an institution they have no relation with.
    const { data: otherAdmRow } = await admin
      .from('user_institutions')
      .select('user_id')
      .eq('institution_id', otherInstitutionId)
      .limit(1)
      .single();
    const { error } = await instAdminClient.from('rights_requests').insert({
      institution_id: institutionId,
      subject_user_id: otherAdmRow!.user_id,
      subject_label: 'x',
      request_type: 'access',
      created_by: instAdminId,
    });
    expect(error).not.toBeNull();
  });

  it('students cannot record requests', async () => {
    const { error } = await studentClient.from('rights_requests').insert({
      institution_id: institutionId,
      subject_label: 'x',
      request_type: 'access',
      created_by: studentId,
    });
    expect(error).not.toBeNull();
  });

  // ── SELECT ────────────────────────────────────────────────────────────

  it("another institution's admin sees nothing", async () => {
    const { data, error } = await otherInstAdminClient
      .from('rights_requests')
      .select('id')
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('students see nothing — one register row can name another subject', async () => {
    const { data, error } = await studentClient
      .from('rights_requests')
      .select('id')
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('super admin reads the register', async () => {
    const { data, error } = await superAdminClient
      .from('rights_requests')
      .select('id')
      .eq('id', requestId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // ── The clock ─────────────────────────────────────────────────────────

  it('no client sets its own clock: due_at is generated', async () => {
    const { error } = await instAdminClient.from('rights_requests').insert({
      institution_id: institutionId,
      subject_label: 'clock tamper',
      request_type: 'access',
      received_at: '2026-09-01',
      due_at: '2027-01-01',
      created_by: instAdminId,
    });
    // PostgREST refuses writes to a generated column outright.
    expect(error).not.toBeNull();
  });

  it('extension beyond three months from receipt is refused (Art. 12(3))', async () => {
    const { error } = await instAdminClient
      .from('rights_requests')
      .update({ extended_due_at: '2026-12-15', extension_reason: 'too long' })
      .eq('id', requestId);
    expect(error).not.toBeNull();
  });

  it('a reasoned extension inside the window is accepted', async () => {
    const { data, error } = await instAdminClient
      .from('rights_requests')
      .update({ extended_due_at: '2026-11-20', extension_reason: `complex ${uid}` })
      .eq('id', requestId)
      .select('extended_due_at')
      .single();
    expect(error).toBeNull();
    expect(data!.extended_due_at).toBe('2026-11-20');
  });

  // ── Closing ───────────────────────────────────────────────────────────

  it('closing without a resolution note is refused', async () => {
    const { error } = await instAdminClient
      .from('rights_requests')
      .update({ status: 'completed' })
      .eq('id', requestId);
    expect(error).not.toBeNull();
  });

  it('completing stamps closure; completing an ERASURE request scrubs the label', async () => {
    // The access request keeps its label on completion…
    const { data: access, error: accessErr } = await instAdminClient
      .from('rights_requests')
      .update({ status: 'completed', resolution_note: `export handed over ${uid}` })
      .eq('id', requestId)
      .select('subject_label, closed_at, closed_by')
      .single();
    expect(accessErr).toBeNull();
    expect(access!.subject_label).toBe(`Parent of student ${uid}`);
    expect(access!.closed_at).not.toBeNull();
    expect(access!.closed_by).toBe(instAdminId);

    // …an erasure request does not: the register must not be the last place
    // the erased name survives.
    const { data: erasure } = await instAdminClient
      .from('rights_requests')
      .insert({
        institution_id: institutionId,
        subject_label: `Erase me ${uid}`,
        request_type: 'erasure',
        created_by: instAdminId,
      })
      .select('id')
      .single();

    const { data: closed, error: closeErr } = await instAdminClient
      .from('rights_requests')
      .update({ status: 'completed', resolution_note: `erased; sweep reviewed ${uid}` })
      .eq('id', erasure!.id)
      .select('subject_label, status')
      .single();
    expect(closeErr).toBeNull();
    expect(closed!.status).toBe('completed');
    expect(closed!.subject_label).toBeNull();
  });

  it('a closed erasure request cannot be recharacterised to smuggle the label back', async () => {
    // Complete an erasure (label scrubbed), then try to flip its type and
    // re-write the label: the trigger freezes request_type on closed rows,
    // and the still-erasure row re-scrubs any label written to it.
    const { data: erasure } = await instAdminClient
      .from('rights_requests')
      .insert({
        institution_id: institutionId,
        subject_label: `Scrub target ${uid}`,
        request_type: 'erasure',
        created_by: instAdminId,
      })
      .select('id')
      .single();
    await instAdminClient
      .from('rights_requests')
      .update({ status: 'completed', resolution_note: `erased ${uid}` })
      .eq('id', erasure!.id);

    const { data, error } = await instAdminClient
      .from('rights_requests')
      .update({ request_type: 'access', subject_label: `Smuggled back ${uid}` })
      .eq('id', erasure!.id)
      .select('request_type, subject_label')
      .single();
    expect(error).toBeNull();
    expect(data!.request_type).toBe('erasure');
    expect(data!.subject_label).toBeNull();
  });

  it('reopening clears the closure stamp', async () => {
    const { data, error } = await instAdminClient
      .from('rights_requests')
      .update({ status: 'open' })
      .eq('id', requestId)
      .select('closed_at, closed_by')
      .single();
    expect(error).toBeNull();
    expect(data!.closed_at).toBeNull();
    expect(data!.closed_by).toBeNull();
  });

  // ── Register integrity ────────────────────────────────────────────────

  it('received_at is immutable — an editable receipt date would be an editable deadline', async () => {
    const { error } = await instAdminClient
      .from('rights_requests')
      .update({ received_at: '2026-09-10' })
      .eq('id', requestId);
    expect(error).not.toBeNull();
  });

  it('provenance survives updates: created_by cannot be rewritten', async () => {
    const { data, error } = await instAdminClient
      .from('rights_requests')
      .update({ created_by: studentId })
      .eq('id', requestId)
      .select('created_by')
      .single();
    expect(error).toBeNull();
    expect(data!.created_by).toBe(instAdminId);
  });

  it('a whitespace-only resolution note is refused', async () => {
    const { error } = await instAdminClient
      .from('rights_requests')
      .update({ status: 'refused', resolution_note: '   ' })
      .eq('id', requestId);
    expect(error).not.toBeNull();
  });

  it('forged closure stamps are overwritten by the trigger', async () => {
    const { data, error } = await instAdminClient
      .from('rights_requests')
      .update({
        status: 'refused',
        resolution_note: `manifestly unfounded; requester informed ${uid}`,
        closed_at: '2020-01-01T00:00:00Z',
        closed_by: studentId,
      })
      .eq('id', requestId)
      .select('closed_at, closed_by')
      .single();
    expect(error).toBeNull();
    expect(data!.closed_by).toBe(instAdminId);
    expect(new Date(data!.closed_at!).getFullYear()).toBeGreaterThan(2020);

    // Back to open for the DELETE test below.
    await instAdminClient.from('rights_requests').update({ status: 'open' }).eq('id', requestId);
  });

  // ── DELETE ────────────────────────────────────────────────────────────

  it('nobody deletes register rows from the app — accountability evidence', async () => {
    for (const client of [instAdminClient, superAdminClient]) {
      const { data, error } = await client
        .from('rights_requests')
        .delete()
        .eq('id', requestId)
        .select('id');
      expect(error).toBeNull(); // RLS silently filters, deleting nothing
      expect(data).toEqual([]);
    }
    const { data: still } = await admin
      .from('rights_requests')
      .select('id')
      .eq('id', requestId);
    expect(still).toHaveLength(1);
  });
});
