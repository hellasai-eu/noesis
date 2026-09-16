// Tables under test:
//   * public.class_announcements
//   * public.announcement_offerings
//   * public.announcement_reads
//   * public.admin_notifications
//   * public.flagged_content
//
// Announcements are section-targeted (#… , 20260421000000): the announcement
// row itself carries only a course_id, and `announcement_offerings` decides
// which sections actually receive it. The SELECT policy on
// `class_announcements` requires BOTH that the reader has access to some
// offering of the course AND that a targeting row exists for an offering they
// can access — so an untargeted announcement is invisible to everyone,
// including students of the course.
//
// `flagged_content` is the moderation queue and is deliberately super-admin
// only: it has no INSERT policy at all (the service role writes it) and no
// institution-admin read path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createClassAnnouncement,
  targetAnnouncementAtOffering,
  markAnnouncementRead,
  createAdminNotification,
  createFlaggedContent,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('announcements, admin notifications and flagged content RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA1: string;
  let classA2: string;
  let offeringA1: string;
  let offeringA2: string;

  let instB: string;
  let courseB: string;
  let classB: string;
  let offeringB: string;

  let targetedAnnouncement: string; // targeted at offeringA1
  let otherSectionAnnouncement: string; // targeted at offeringA2 only
  let untargetedAnnouncement: string; // no announcement_offerings row
  let foreignAnnouncement: string;

  let ownRead: string;
  let notificationId: string;
  let flaggedId: string;

  let studentClient: SupabaseClient; // class A1
  let studentId: string;
  let otherSectionStudentClient: SupabaseClient; // class A2
  let otherSectionStudentId: string;
  let instructorClient: SupabaseClient;
  let adminAClient: SupabaseClient;
  let outsiderClient: SupabaseClient;
  let superAdminClient: SupabaseClient;

  const superAdminEmail = `rls-ann-sa-${uid}@test.local`;
  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Ann A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA1 = await createClass(admin, instA);
    classA2 = await createClass(admin, instA);
    offeringA1 = await createOffering(admin, classA1, courseA);
    offeringA2 = await createOffering(admin, classA2, courseA);

    instB = await createInstitution(admin, `RLS Ann B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);
    offeringB = await createOffering(admin, classB, courseB);

    const stu = await createTestUserClient(admin, `rls-ann-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA1, stu.userId, 'student');

    const other = await createTestUserClient(admin, `rls-ann-other-${uid}@test.local`);
    otherSectionStudentClient = other.client;
    otherSectionStudentId = other.userId;
    userIds.push(other.userId);
    await addUserToInstitution(admin, other.userId, instA, 'student');
    await enrollInClass(admin, classA2, other.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-ann-instr-${uid}@test.local`);
    instructorClient = instr.client; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const adm = await createTestUserClient(admin, `rls-ann-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const out = await createTestUserClient(admin, `rls-ann-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'student');
    await enrollInClass(admin, classB, out.userId, 'student');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    targetedAnnouncement = await createClassAnnouncement(admin, courseA);
    await targetAnnouncementAtOffering(admin, targetedAnnouncement, offeringA1);

    otherSectionAnnouncement = await createClassAnnouncement(admin, courseA);
    await targetAnnouncementAtOffering(admin, otherSectionAnnouncement, offeringA2);

    untargetedAnnouncement = await createClassAnnouncement(admin, courseA);

    foreignAnnouncement = await createClassAnnouncement(admin, courseB);
    await targetAnnouncementAtOffering(admin, foreignAnnouncement, offeringB);

    await markAnnouncementRead(admin, targetedAnnouncement, studentId);
    ownRead = targetedAnnouncement;

    notificationId = await createAdminNotification(admin, {
      courseId: courseA, studentId,
    });
    flaggedId = await createFlaggedContent(admin);
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // class_announcements + announcement_offerings
  // =====================================================================

  it('student reads an announcement targeted at their section', async () => {
    const { data, error } = await studentClient
      .from('class_announcements').select('id').eq('id', targetedAnnouncement);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student does not read an announcement targeted at a sibling section', async () => {
    const { data, error } = await studentClient
      .from('class_announcements').select('id').eq('id', otherSectionAnnouncement);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    // …and the mirror image, so this is targeting rather than an accident.
    const { data: mirror } = await otherSectionStudentClient
      .from('class_announcements').select('id').eq('id', otherSectionAnnouncement);
    expect(mirror).toHaveLength(1);
  });

  it('an untargeted announcement is invisible to every student in the course', async () => {
    // The SELECT policy demands a matching announcement_offerings row, so an
    // announcement with no targeting reaches nobody — it is a draft in effect.
    const { data: bySection1 } = await studentClient
      .from('class_announcements').select('id').eq('id', untargetedAnnouncement);
    expect(bySection1).toHaveLength(0);

    const { data: bySection2 } = await otherSectionStudentClient
      .from('class_announcements').select('id').eq('id', untargetedAnnouncement);
    expect(bySection2).toHaveLength(0);
  });

  it('student of another institution reads no announcement of this one', async () => {
    const { data, error } = await outsiderClient
      .from('class_announcements')
      .select('id')
      .in('id', [targetedAnnouncement, otherSectionAnnouncement, untargetedAnnouncement]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('assigned instructor can author and target an announcement', async () => {
    const { data: created, error } = await instructorClient
      .from('class_announcements')
      .insert({ course_id: courseA, title: `instructor announcement ${uid}`, body: 'body' })
      .select('id').single();
    expect(error).toBeNull();
    expect(created).not.toBeNull();

    const { error: targetError } = await instructorClient
      .from('announcement_offerings')
      .insert({ announcement_id: (created as { id: string }).id, offering_id: offeringA1 });
    expect(targetError).toBeNull();
  });

  it('student cannot author, edit or target an announcement', async () => {
    const { error: insertError } = await studentClient
      .from('class_announcements')
      .insert({ course_id: courseA, title: 'student announcement', body: 'body' });
    expect(insertError).not.toBeNull();

    const { data: updated } = await studentClient
      .from('class_announcements')
      .update({ title: 'edited' }).eq('id', targetedAnnouncement).select();
    expect(updated).toHaveLength(0);

    const { error: targetError } = await studentClient
      .from('announcement_offerings')
      .insert({ announcement_id: untargetedAnnouncement, offering_id: offeringA1 });
    expect(targetError).not.toBeNull();
  });

  it('student sees the targeting row for their own section only', async () => {
    const { data: own, error } = await studentClient
      .from('announcement_offerings')
      .select('announcement_id').eq('announcement_id', targetedAnnouncement);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: other } = await studentClient
      .from('announcement_offerings')
      .select('announcement_id').eq('announcement_id', otherSectionAnnouncement);
    expect(other).toHaveLength(0);
  });

  // =====================================================================
  // announcement_reads
  // =====================================================================

  it('student sees their own read receipt and not a classmate’s', async () => {
    const { data: mine, error } = await studentClient
      .from('announcement_reads')
      .select('announcement_id').eq('announcement_id', ownRead).eq('user_id', studentId);
    expect(error).toBeNull();
    expect(mine).toHaveLength(1);

    await markAnnouncementRead(admin, otherSectionAnnouncement, otherSectionStudentId);
    const { data: theirs } = await studentClient
      .from('announcement_reads')
      .select('announcement_id').eq('user_id', otherSectionStudentId);
    expect(theirs).toHaveLength(0);
  });

  it('student can record and withdraw their own read receipt', async () => {
    const announcement = await createClassAnnouncement(admin, courseA);
    await targetAnnouncementAtOffering(admin, announcement, offeringA1);

    const { error: insertError } = await studentClient
      .from('announcement_reads')
      .insert({ announcement_id: announcement, user_id: studentId });
    expect(insertError).toBeNull();

    const { data: deleted } = await studentClient
      .from('announcement_reads')
      .delete().eq('announcement_id', announcement).eq('user_id', studentId).select();
    expect(deleted).toHaveLength(1);
  });

  it('student cannot record a read receipt in another user’s name', async () => {
    const { error } = await studentClient
      .from('announcement_reads')
      .insert({ announcement_id: targetedAnnouncement, user_id: otherSectionStudentId });
    expect(error).not.toBeNull();
  });

  it('student cannot record a read against an announcement they cannot see', async () => {
    // The WITH CHECK repeats the targeting predicate, so a read receipt is not
    // a way to confirm that an announcement exists for another section.
    const { error: otherSection } = await studentClient
      .from('announcement_reads')
      .insert({ announcement_id: otherSectionAnnouncement, user_id: studentId });
    expect(otherSection).not.toBeNull();

    const { error: untargeted } = await studentClient
      .from('announcement_reads')
      .insert({ announcement_id: untargetedAnnouncement, user_id: studentId });
    expect(untargeted).not.toBeNull();
  });

  // =====================================================================
  // admin_notifications
  // =====================================================================

  it('assigned instructor and institution admin read course notifications', async () => {
    const { data: byInstructor, error } = await instructorClient
      .from('admin_notifications').select('id').eq('id', notificationId);
    expect(error).toBeNull();
    expect(byInstructor).toHaveLength(1);

    const { data: byAdmin } = await adminAClient
      .from('admin_notifications').select('id').eq('id', notificationId);
    expect(byAdmin).toHaveLength(1);
  });

  it('the student the notification is about cannot read it', async () => {
    // admin_notifications is staff-facing: `student_id` names who it concerns,
    // not who may read it. There is no student grant on this table.
    const { data, error } = await studentClient
      .from('admin_notifications').select('id').eq('id', notificationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('instructor can mark a notification read but a student cannot', async () => {
    const { data: byInstructor, error } = await instructorClient
      .from('admin_notifications').update({ read: true }).eq('id', notificationId).select('id');
    expect(error).toBeNull();
    expect(byInstructor).toHaveLength(1);

    const { data: byStudent } = await studentClient
      .from('admin_notifications').update({ read: false }).eq('id', notificationId).select();
    expect(byStudent).toHaveLength(0);
  });

  it('staff of another institution read no notification of this one', async () => {
    const { data, error } = await outsiderClient
      .from('admin_notifications').select('id').eq('id', notificationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // flagged_content — super admin only
  // =====================================================================

  it('super admin reads the moderation queue', async () => {
    const { data, error } = await superAdminClient
      .from('flagged_content').select('id').eq('id', flaggedId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('nobody below super admin reads the moderation queue', async () => {
    for (const [label, client] of [
      ['student', studentClient],
      ['instructor', instructorClient],
      ['institution admin', adminAClient],
    ] as const) {
      const { data, error } = await client
        .from('flagged_content').select('id').eq('id', flaggedId);
      expect(error, label).toBeNull();
      expect(data, label).toHaveLength(0);
    }
  });

  it('nobody can insert flagged content through the API, not even a super admin', async () => {
    // There is no INSERT policy on this table at any level — the moderation
    // pipeline writes it with the service role.
    for (const [label, client] of [
      ['student', studentClient],
      ['institution admin', adminAClient],
      ['super admin', superAdminClient],
    ] as const) {
      const { error } = await client
        .from('flagged_content')
        .insert({ description: `forged ${label}`, data: { reason: 'forged' } });
      expect(error, label).not.toBeNull();
    }
  });

  it('only a super admin can clear the moderation queue', async () => {
    const { data: byAdmin } = await adminAClient
      .from('flagged_content').delete().eq('id', flaggedId).select();
    expect(byAdmin).toHaveLength(0);

    const { data: bySuperAdmin } = await superAdminClient
      .from('flagged_content').delete().eq('id', flaggedId).select('id');
    expect(bySuperAdmin).toHaveLength(1);
  });
});
