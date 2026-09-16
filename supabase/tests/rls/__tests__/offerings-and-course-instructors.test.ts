// Tables under test:
//   * public.offerings
//   * public.course_instructors
//   * public.course_instructor_sections
//
// These three are the spine of instructor authorization: almost every other
// policy in the schema reaches them through `can_manage_offering()`,
// `is_course_instructor()` or `instructor_can_access_section()`. They had no
// RLS coverage of their own (#1095) — a policy that was never asserted is
// indistinguishable from one that was written wrong.
//
// Migrations that shaped the policies covered here:
//   * 20251229065522_53a2d1cf-... .sql
//       - CREATE TABLE offerings; "Class members can view offerings" (SELECT,
//         is_class_member) and the original "Managers can manage offerings".
//   * 20260331000000_course_instructors_and_academic_period.sql
//       - CREATE TABLE course_instructors; "Admins can manage course
//         instructors" (ALL, admins only) + "Institution members can view
//         course instructors" (SELECT, any member of the owning institution).
//   * 20260401000000_migrate_instructor_rbac_to_course_instructors.sql
//       - is_course_instructor() reads course_instructors instead of
//         class_enrollments (#52).
//   * 20260402000000_add_course_instructor_sections.sql
//       - CREATE TABLE course_instructor_sections + instructor_can_access_section();
//         rewrites "Managers can manage offerings" to AND in the section check.
//         Section rows are opt-in narrowing: no rows at all = every section.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSectionRestriction,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('offerings + course_instructors + course_instructor_sections RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  // Institution A — the tenant under test.
  let instA: string;
  let courseA: string;
  let classA1: string;
  let classA2: string;
  let classA3: string; // deliberately has no offering, used for INSERT probes
  let offeringA1: string;
  let offeringA2: string;

  // Institution B — the other tenant, must see and touch nothing above.
  let instB: string;
  let courseB: string;
  let classB1: string;
  let offeringB1: string;

  let adminAClient: SupabaseClient;
  let adminBClient: SupabaseClient;

  // Assigned to courseA with no section rows → every section of courseA.
  let instrFullClient: SupabaseClient;
  let instrFullId: string;

  // Assigned to courseA and restricted to classA1 only.
  let instrRestrictedClient: SupabaseClient;
  let instrRestrictedId: string;

  // A second restricted instructor on the same course, confined to classA2.
  // Exists so the "can't see someone else's restrictions" probe has a real row
  // to miss without any test having to create and tear one down mid-run.
  let instrPeerClient: SupabaseClient;
  let instrPeerId: string;

  // Institution A instructor with no course_instructors row at all.
  let instrUnassignedClient: SupabaseClient;
  let instrUnassignedId: string;

  // Assigned to courseA, then suspended — see the #1082 note at its test.
  let instrSuspendedClient: SupabaseClient;

  let studentA1Client: SupabaseClient;
  let studentA2Client: SupabaseClient;
  let outsiderClient: SupabaseClient; // institution B student

  let superAdminClient: SupabaseClient;
  const superAdminEmail = `rls-off-sa-${uid}@test.local`;

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Off A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA1 = await createClass(admin, instA);
    classA2 = await createClass(admin, instA);
    classA3 = await createClass(admin, instA);
    offeringA1 = await createOffering(admin, classA1, courseA);
    offeringA2 = await createOffering(admin, classA2, courseA);

    instB = await createInstitution(admin, `RLS Off B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB1 = await createClass(admin, instB);
    offeringB1 = await createOffering(admin, classB1, courseB);

    const aAdmin = await createTestUserClient(admin, `rls-off-admin-a-${uid}@test.local`);
    adminAClient = aAdmin.client; userIds.push(aAdmin.userId);
    await addUserToInstitution(admin, aAdmin.userId, instA, 'admin');

    const bAdmin = await createTestUserClient(admin, `rls-off-admin-b-${uid}@test.local`);
    adminBClient = bAdmin.client; userIds.push(bAdmin.userId);
    await addUserToInstitution(admin, bAdmin.userId, instB, 'admin');

    const full = await createTestUserClient(admin, `rls-off-instr-full-${uid}@test.local`);
    instrFullClient = full.client; instrFullId = full.userId; userIds.push(full.userId);
    await addUserToInstitution(admin, full.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, full.userId);

    const restricted = await createTestUserClient(admin, `rls-off-instr-sec-${uid}@test.local`);
    instrRestrictedClient = restricted.client;
    instrRestrictedId = restricted.userId;
    userIds.push(restricted.userId);
    await addUserToInstitution(admin, restricted.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, restricted.userId);
    await addSectionRestriction(admin, courseA, classA1, restricted.userId);

    const peer = await createTestUserClient(admin, `rls-off-instr-peer-${uid}@test.local`);
    instrPeerClient = peer.client;
    instrPeerId = peer.userId;
    userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, peer.userId);
    await addSectionRestriction(admin, courseA, classA2, peer.userId);

    const unassigned = await createTestUserClient(admin, `rls-off-instr-none-${uid}@test.local`);
    instrUnassignedClient = unassigned.client;
    instrUnassignedId = unassigned.userId;
    userIds.push(unassigned.userId);
    await addUserToInstitution(admin, unassigned.userId, instA, 'instructor');

    const suspended = await createTestUserClient(admin, `rls-off-instr-susp-${uid}@test.local`);
    instrSuspendedClient = suspended.client; userIds.push(suspended.userId);
    await addUserToInstitution(admin, suspended.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, suspended.userId);
    const { error: suspendError } = await admin
      .from('user_institutions')
      .update({ is_suspended: true })
      .eq('user_id', suspended.userId)
      .eq('institution_id', instA);
    if (suspendError) throw new Error(`suspend instructor: ${suspendError.message}`);

    const s1 = await createTestUserClient(admin, `rls-off-stu-a1-${uid}@test.local`);
    studentA1Client = s1.client; userIds.push(s1.userId);
    await addUserToInstitution(admin, s1.userId, instA, 'student');
    await enrollInClass(admin, classA1, s1.userId, 'student');

    const s2 = await createTestUserClient(admin, `rls-off-stu-a2-${uid}@test.local`);
    studentA2Client = s2.client; userIds.push(s2.userId);
    await addUserToInstitution(admin, s2.userId, instA, 'student');
    await enrollInClass(admin, classA2, s2.userId, 'student');

    const out = await createTestUserClient(admin, `rls-off-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'student');
    await enrollInClass(admin, classB1, out.userId, 'student');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // offerings — SELECT
  // =====================================================================

  it('enrolled student sees the offering of their own class', async () => {
    const { data, error } = await studentA1Client
      .from('offerings').select('id').eq('id', offeringA1);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('enrolled student does not see the offering of a sibling class', async () => {
    // is_class_member() is per-class, not per-institution: same course, same
    // institution, different section is still invisible.
    const { data, error } = await studentA1Client
      .from('offerings').select('id').eq('id', offeringA2);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('the sibling class’s student sees the mirror image', async () => {
    const { data, error } = await studentA2Client
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(data?.map((o) => o.id)).toEqual([offeringA2]);
  });

  it('student of another institution sees no offering of this one', async () => {
    const { data, error } = await outsiderClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('unrestricted course instructor sees every section of the course', async () => {
    const { data, error } = await instrFullClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(data?.map((o) => o.id).sort()).toEqual([offeringA1, offeringA2].sort());
  });

  it('section-restricted instructor sees only the allowed section', async () => {
    const { data, error } = await instrRestrictedClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(data?.map((o) => o.id)).toEqual([offeringA1]);
  });

  it('a second restricted instructor is confined to their own section', async () => {
    // Same course, disjoint section: restriction is per (course, class, user),
    // so two instructors on one course can see strictly different offerings.
    const { data, error } = await instrPeerClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(data?.map((o) => o.id)).toEqual([offeringA2]);
  });

  it('instructor with no course assignment sees no offering of that course', async () => {
    // Institution membership alone grants nothing on offerings — the row has to
    // come through class enrolment or a course_instructors assignment.
    const { data, error } = await instrUnassignedClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin sees every offering in their institution and none outside it', async () => {
    const { data: own, error } = await adminAClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2]);
    expect(error).toBeNull();
    expect(own).toHaveLength(2);

    const { data: foreign } = await adminAClient
      .from('offerings').select('id').eq('id', offeringB1);
    expect(foreign).toHaveLength(0);
  });

  it('super admin sees offerings across institutions', async () => {
    const { data, error } = await superAdminClient
      .from('offerings').select('id').in('id', [offeringA1, offeringA2, offeringB1]);
    expect(error).toBeNull();
    expect(data).toHaveLength(3);
  });

  // =====================================================================
  // offerings — INSERT / UPDATE / DELETE
  // =====================================================================

  it('student cannot create an offering', async () => {
    const { error } = await studentA1Client
      .from('offerings').insert({ class_id: classA3, course_id: courseA });
    expect(error).not.toBeNull();
  });

  it('student cannot update or delete an offering they can read', async () => {
    const { data: updated } = await studentA1Client
      .from('offerings').update({ is_active: false }).eq('id', offeringA1).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await studentA1Client
      .from('offerings').delete().eq('id', offeringA1).select();
    expect(deleted).toHaveLength(0);
  });

  it('unrestricted course instructor can create an offering for a new section', async () => {
    // Its own class, so classA3 stays free of rows for the denial probes and
    // this test carries no ordering dependency on them.
    const freshClass = await createClass(admin, instA);
    const { data, error } = await instrFullClient
      .from('offerings')
      .insert({ class_id: freshClass, course_id: courseA })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('section-restricted instructor cannot create an offering outside their sections', async () => {
    const { error } = await instrRestrictedClient
      .from('offerings').insert({ class_id: classA3, course_id: courseA });
    expect(error).not.toBeNull();
  });

  it('section-restricted instructor cannot update an offering outside their sections', async () => {
    const { data } = await instrRestrictedClient
      .from('offerings').update({ is_active: false }).eq('id', offeringA2).select();
    expect(data).toHaveLength(0);
  });

  it('institution admin can update an offering in their own institution', async () => {
    const { data, error } = await adminAClient
      .from('offerings').update({ leaderboard_enabled: false }).eq('id', offeringA2).select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    await admin.from('offerings').update({ leaderboard_enabled: true }).eq('id', offeringA2);
  });

  it('admin of another institution cannot update or delete this institution’s offering', async () => {
    const { data: updated } = await adminBClient
      .from('offerings').update({ is_active: false }).eq('id', offeringA1).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await adminBClient
      .from('offerings').delete().eq('id', offeringA1).select();
    expect(deleted).toHaveLength(0);
  });

  it('admin of another institution cannot create an offering here', async () => {
    const { error } = await adminBClient
      .from('offerings').insert({ class_id: classA3, course_id: courseA });
    expect(error).not.toBeNull();
  });

  // =====================================================================
  // course_instructors
  // =====================================================================

  it('any institution member can read course instructor assignments', async () => {
    // The SELECT policy is deliberately institution-wide — students see who
    // teaches a course. It is scoped to the owning institution, nothing more.
    const { data, error } = await studentA1Client
      .from('course_instructors').select('user_id').eq('course_id', courseA);
    expect(error).toBeNull();
    expect(data?.map((r) => r.user_id)).toContain(instrFullId);
  });

  it('member of another institution reads no assignment of this one', async () => {
    const { data, error } = await outsiderClient
      .from('course_instructors').select('user_id').eq('course_id', courseA);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin can assign and unassign a course instructor', async () => {
    const { error: insertError } = await adminAClient
      .from('course_instructors')
      .insert({ course_id: courseA, user_id: instrUnassignedId });
    expect(insertError).toBeNull();

    const { data: removed } = await adminAClient
      .from('course_instructors')
      .delete()
      .eq('course_id', courseA)
      .eq('user_id', instrUnassignedId)
      .select();
    expect(removed).toHaveLength(1);
  });

  it('instructor cannot assign themselves to another course', async () => {
    const { error } = await instrUnassignedClient
      .from('course_instructors')
      .insert({ course_id: courseA, user_id: instrUnassignedId });
    expect(error).not.toBeNull();
  });

  it('student cannot remove a course instructor assignment', async () => {
    const { data } = await studentA1Client
      .from('course_instructors')
      .delete()
      .eq('course_id', courseA)
      .eq('user_id', instrFullId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('admin of another institution cannot assign an instructor here', async () => {
    const { error } = await adminBClient
      .from('course_instructors')
      .insert({ course_id: courseA, user_id: instrUnassignedId });
    expect(error).not.toBeNull();
  });

  it('suspending the membership does not revoke the course assignment (#1082)', async () => {
    // Characterization test, not an endorsement. is_institution_admin() and
    // user_belongs_to_institution() both filter on `NOT is_suspended`
    // (20260323000000), but is_course_instructor() reads course_instructors,
    // which carries no suspension state at all — so a suspended instructor
    // keeps every course they were assigned. #1082 tracks the fix; when it
    // lands this expectation flips to toHaveLength(0) and the test stays.
    const { data, error } = await instrSuspendedClient
      .from('offerings').select('id').eq('id', offeringA1);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // =====================================================================
  // course_instructor_sections
  // =====================================================================

  it('instructor can read their own section restrictions', async () => {
    const { data, error } = await instrRestrictedClient
      .from('course_instructor_sections')
      .select('class_id')
      .eq('course_id', courseA)
      .eq('user_id', instrRestrictedId);
    expect(error).toBeNull();
    expect(data?.map((r) => r.class_id)).toEqual([classA1]);
  });

  it('instructor cannot read another instructor’s section restrictions', async () => {
    const { data, error } = await instrRestrictedClient
      .from('course_instructor_sections')
      .select('class_id')
      .eq('course_id', courseA)
      .eq('user_id', instrPeerId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an unfiltered read returns an instructor only their own restrictions', async () => {
    // The row instrPeer owns is real and on the same course, so a policy that
    // leaked by course rather than by user would show up here as two rows.
    const { data, error } = await instrRestrictedClient
      .from('course_instructor_sections').select('user_id, class_id').eq('course_id', courseA);
    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: instrRestrictedId, class_id: classA1 }]);
  });

  it('institution admin reads every section restriction on their courses', async () => {
    const { data, error } = await adminAClient
      .from('course_instructor_sections').select('user_id').eq('course_id', courseA);
    expect(error).toBeNull();
    expect(data?.map((r) => r.user_id).sort()).toEqual([instrRestrictedId, instrPeerId].sort());
  });

  it('admin of another institution reads no section restriction of this one', async () => {
    const { data, error } = await adminBClient
      .from('course_instructor_sections').select('user_id').eq('course_id', courseA);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin can add and remove a section restriction', async () => {
    const { error: insertError } = await adminAClient
      .from('course_instructor_sections')
      .insert({ course_id: courseA, class_id: classA2, user_id: instrRestrictedId });
    expect(insertError).toBeNull();

    const { data: removed } = await adminAClient
      .from('course_instructor_sections')
      .delete()
      .eq('course_id', courseA)
      .eq('class_id', classA2)
      .eq('user_id', instrRestrictedId)
      .select();
    expect(removed).toHaveLength(1);
  });

  it('instructor cannot widen their own section access', async () => {
    // The escalation this table exists to prevent: instrRestricted is confined
    // to classA1, and granting themselves classA2 would hand them offeringA2.
    const { error } = await instrRestrictedClient
      .from('course_instructor_sections')
      .insert({ course_id: courseA, class_id: classA2, user_id: instrRestrictedId });
    expect(error).not.toBeNull();

    const { data: stillHidden } = await instrRestrictedClient
      .from('offerings').select('id').eq('id', offeringA2);
    expect(stillHidden).toHaveLength(0);
  });

  it('instructor cannot delete their own section restriction', async () => {
    const { data } = await instrRestrictedClient
      .from('course_instructor_sections')
      .delete()
      .eq('course_id', courseA)
      .eq('class_id', classA1)
      .eq('user_id', instrRestrictedId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('student cannot read or write section restrictions', async () => {
    const { data: read } = await studentA1Client
      .from('course_instructor_sections').select('user_id').eq('course_id', courseA);
    expect(read).toHaveLength(0);

    const { error } = await studentA1Client
      .from('course_instructor_sections')
      .insert({ course_id: courseA, class_id: classA2, user_id: instrRestrictedId });
    expect(error).not.toBeNull();
  });
});
