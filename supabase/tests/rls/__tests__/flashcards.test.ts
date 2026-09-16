// Tables under test:
//   * public.flashcard_reviews            — per-user spaced-repetition state
//   * public.flashcard_sessions           — a user's saved practice set
//   * public.offering_flashcard_sessions  — a session assigned to a section
//   * public.offering_chapter_flashcards  — chapter flashcards published to a section
//   * public.offering_chapter_cheatsheets — chapter cheatsheets published to a section
//
// Two different shapes sit side by side here, which is the point of covering
// them together:
//
//   * The two personal tables are owner-only. `flashcard_sessions` has no
//     instructor or admin policy at all — not even a super admin can read
//     someone's saved practice set through the API. `flashcard_reviews` adds
//     one read grant for admins and assigned instructors, and nothing more.
//   * The three `offering_*` tables are ordinary published-content tables
//     gated by can_manage_offering / has_offering_access, with the group
//     predicate for per-student targeting.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseMaterial,
  createMaterialChapter,
  createFlashcardReview,
  createFlashcardSession,
  createOfferingChapterFlashcards,
  createOfferingChapterCheatsheet,
  createOfferingFlashcardSession,
  createOfferingGroup,
  addOfferingGroupMember,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('flashcard_reviews + flashcard_sessions + offering flashcard content RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA: string;
  let offeringA: string;
  let chapterA: string;

  let instB: string;
  let courseB: string;
  let classB: string;
  let offeringB: string;
  let chapterB: string;

  let ownReview: string;
  let peerReview: string;
  let foreignReview: string;
  let ownSession: string;
  let peerSession: string;

  let publishedFlashcards: string;
  let unpublishedFlashcards: string;
  let groupFlashcards: string;
  let publishedCheatsheet: string;
  let unpublishedCheatsheet: string;
  let publishedOfferingSession: string;
  let unpublishedOfferingSession: string;

  let groupId: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient;
  let peerId: string;
  let instructorClient: SupabaseClient;
  let adminAClient: SupabaseClient;
  let outsiderClient: SupabaseClient;
  let superAdminClient: SupabaseClient;

  const superAdminEmail = `rls-fc-sa-${uid}@test.local`;
  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS FC A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    offeringA = await createOffering(admin, classA, courseA);
    chapterA = await createMaterialChapter(admin, await createCourseMaterial(admin, courseA));

    instB = await createInstitution(admin, `RLS FC B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);
    offeringB = await createOffering(admin, classB, courseB);
    chapterB = await createMaterialChapter(admin, await createCourseMaterial(admin, courseB));

    const stu = await createTestUserClient(admin, `rls-fc-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-fc-peer-${uid}@test.local`);
    peerClient = peer.client; peerId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-fc-instr-${uid}@test.local`);
    instructorClient = instr.client; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const adm = await createTestUserClient(admin, `rls-fc-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const out = await createTestUserClient(admin, `rls-fc-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'student');
    await enrollInClass(admin, classB, out.userId, 'student');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    ownReview = await createFlashcardReview(admin, {
      userId: studentId, chapterId: chapterA, courseId: courseA, flashcardIndex: 0,
    });
    peerReview = await createFlashcardReview(admin, {
      userId: peerId, chapterId: chapterA, courseId: courseA, flashcardIndex: 1,
    });
    foreignReview = await createFlashcardReview(admin, {
      userId: peerId, chapterId: chapterB, courseId: courseB, flashcardIndex: 0,
    });

    ownSession = await createFlashcardSession(admin, {
      userId: studentId, courseId: courseA, chapterIds: [chapterA],
    });
    peerSession = await createFlashcardSession(admin, {
      userId: peerId, courseId: courseA, chapterIds: [chapterA],
    });

    groupId = await createOfferingGroup(admin, offeringA, { name: `FC group ${uid}` });
    await addOfferingGroupMember(admin, groupId, studentId);

    publishedFlashcards = await createOfferingChapterFlashcards(admin, offeringA, chapterA, {
      published: true,
    });
    unpublishedFlashcards = await createOfferingChapterFlashcards(admin, offeringB, chapterB, {
      published: false,
    });
    groupFlashcards = await createOfferingChapterFlashcards(admin, offeringA, chapterA, {
      published: true, groupId,
    });
    publishedCheatsheet = await createOfferingChapterCheatsheet(admin, offeringA, chapterA, {
      published: true,
    });
    unpublishedCheatsheet = await createOfferingChapterCheatsheet(admin, offeringB, chapterB, {
      published: false,
    });
    publishedOfferingSession = await createOfferingFlashcardSession(
      admin, offeringA, ownSession, { published: true }
    );
    unpublishedOfferingSession = await createOfferingFlashcardSession(
      admin, offeringB, await createFlashcardSession(admin, {
        userId: peerId, courseId: courseB, chapterIds: [chapterB],
      }), { published: false }
    );
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // flashcard_reviews
  // =====================================================================

  it('student manages their own review state', async () => {
    const { data: read, error } = await studentClient
      .from('flashcard_reviews').select('id').eq('id', ownReview);
    expect(error).toBeNull();
    expect(read).toHaveLength(1);

    const { data: updated, error: updateError } = await studentClient
      .from('flashcard_reviews').update({ repetitions: 3 }).eq('id', ownReview).select('id');
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
  });

  it('student cannot read or alter a classmate’s review state', async () => {
    const { data: read } = await studentClient
      .from('flashcard_reviews').select('id').eq('id', peerReview);
    expect(read).toHaveLength(0);

    const { data: updated } = await studentClient
      .from('flashcard_reviews').update({ repetitions: 99 }).eq('id', peerReview).select();
    expect(updated).toHaveLength(0);
  });

  it('student cannot create review state in another user’s name', async () => {
    const { error } = await studentClient
      .from('flashcard_reviews')
      .insert({
        user_id: peerId, chapter_id: chapterA, course_id: courseA, flashcard_index: 9,
      });
    expect(error).not.toBeNull();
  });

  it('assigned instructor and institution admin can read review state in their course', async () => {
    const { data: byInstructor, error } = await instructorClient
      .from('flashcard_reviews').select('id').in('id', [ownReview, peerReview]);
    expect(error).toBeNull();
    expect(byInstructor).toHaveLength(2);

    const { data: byAdmin } = await adminAClient
      .from('flashcard_reviews').select('id').in('id', [ownReview, peerReview]);
    expect(byAdmin).toHaveLength(2);
  });

  it('instructor can read but not rewrite a student’s review state', async () => {
    // The instructor grant is SELECT only; the write path belongs to the
    // owner's FOR ALL policy, which is keyed on user_id = auth.uid().
    const { data: updated } = await instructorClient
      .from('flashcard_reviews').update({ repetitions: 42 }).eq('id', ownReview).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await instructorClient
      .from('flashcard_reviews').delete().eq('id', ownReview).select();
    expect(deleted).toHaveLength(0);
  });

  it('nobody in another institution reads this institution’s review state', async () => {
    const { data, error } = await outsiderClient
      .from('flashcard_reviews').select('id').in('id', [ownReview, peerReview]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: reverse } = await studentClient
      .from('flashcard_reviews').select('id').eq('id', foreignReview);
    expect(reverse).toHaveLength(0);
  });

  // =====================================================================
  // flashcard_sessions — owner-only, with no staff grant at all
  // =====================================================================

  it('student manages their own saved practice set', async () => {
    const { data: read, error } = await studentClient
      .from('flashcard_sessions').select('id').eq('id', ownSession);
    expect(error).toBeNull();
    expect(read).toHaveLength(1);

    const { data: updated, error: updateError } = await studentClient
      .from('flashcard_sessions').update({ cards_per_session: 5 }).eq('id', ownSession).select('id');
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
  });

  it('student cannot see a classmate’s saved practice set', async () => {
    const { data, error } = await studentClient
      .from('flashcard_sessions').select('id').eq('id', peerSession);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('not even an instructor, admin or super admin can read a saved practice set', async () => {
    // flashcard_sessions carries four policies and every one of them is
    // `auth.uid() = user_id`. There is no staff read path, by design.
    for (const [label, client] of [
      ['instructor', instructorClient],
      ['admin', adminAClient],
      ['super admin', superAdminClient],
    ] as const) {
      const { data, error } = await client
        .from('flashcard_sessions').select('id').eq('id', ownSession);
      expect(error, label).toBeNull();
      expect(data, label).toHaveLength(0);
    }
  });

  it('student can delete their own practice set but not a classmate’s', async () => {
    const disposable = await createFlashcardSession(admin, {
      userId: studentId, courseId: courseA, chapterIds: [chapterA],
    });
    const { data: mine } = await studentClient
      .from('flashcard_sessions').delete().eq('id', disposable).select('id');
    expect(mine).toHaveLength(1);

    const { data: theirs } = await studentClient
      .from('flashcard_sessions').delete().eq('id', peerSession).select();
    expect(theirs).toHaveLength(0);
  });

  it('student cannot create a practice set in another user’s name', async () => {
    const { error } = await studentClient
      .from('flashcard_sessions')
      .insert({
        user_id: peerId, course_id: courseA, chapter_ids: [chapterA], name: 'not mine',
      });
    expect(error).not.toBeNull();
  });

  // =====================================================================
  // offering_chapter_flashcards / _cheatsheets / offering_flashcard_sessions
  // =====================================================================

  it('enrolled student sees published chapter flashcards and cheatsheets', async () => {
    const { data: flashcards, error } = await studentClient
      .from('offering_chapter_flashcards').select('id').eq('id', publishedFlashcards);
    expect(error).toBeNull();
    expect(flashcards).toHaveLength(1);

    const { data: cheatsheet } = await studentClient
      .from('offering_chapter_cheatsheets').select('id').eq('id', publishedCheatsheet);
    expect(cheatsheet).toHaveLength(1);
  });

  it('a group-targeted row reaches its member and not a classmate outside the group', async () => {
    const { data: member } = await studentClient
      .from('offering_chapter_flashcards').select('id').eq('id', groupFlashcards);
    expect(member).toHaveLength(1);

    const { data: nonMember } = await peerClient
      .from('offering_chapter_flashcards').select('id').eq('id', groupFlashcards);
    expect(nonMember).toHaveLength(0);
  });

  it('student sees a published offering flashcard session', async () => {
    const { data, error } = await studentClient
      .from('offering_flashcard_sessions').select('id').eq('id', publishedOfferingSession);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('unpublished offering content stays invisible to students', async () => {
    const { data: flashcards } = await outsiderClient
      .from('offering_chapter_flashcards').select('id').eq('id', unpublishedFlashcards);
    expect(flashcards).toHaveLength(0);

    const { data: cheatsheet } = await outsiderClient
      .from('offering_chapter_cheatsheets').select('id').eq('id', unpublishedCheatsheet);
    expect(cheatsheet).toHaveLength(0);

    const { data: session } = await outsiderClient
      .from('offering_flashcard_sessions').select('id').eq('id', unpublishedOfferingSession);
    expect(session).toHaveLength(0);
  });

  it('student of another institution sees none of this institution’s offering content', async () => {
    const { data: flashcards, error } = await outsiderClient
      .from('offering_chapter_flashcards').select('id').in('id', [publishedFlashcards, groupFlashcards]);
    expect(error).toBeNull();
    expect(flashcards).toHaveLength(0);

    const { data: cheatsheet } = await outsiderClient
      .from('offering_chapter_cheatsheets').select('id').eq('id', publishedCheatsheet);
    expect(cheatsheet).toHaveLength(0);

    const { data: session } = await outsiderClient
      .from('offering_flashcard_sessions').select('id').eq('id', publishedOfferingSession);
    expect(session).toHaveLength(0);
  });

  it('assigned instructor can publish and unpublish chapter content', async () => {
    // Its own chapter: (offering, chapter, group) is unique, and the scaffold
    // already holds (offeringA, chapterA, null).
    const freshChapter = await createMaterialChapter(
      admin, await createCourseMaterial(admin, courseA)
    );
    const { data: created, error } = await instructorClient
      .from('offering_chapter_cheatsheets')
      .insert({
        offering_id: offeringA, chapter_id: freshChapter, published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(created).not.toBeNull();

    const { data: deleted } = await instructorClient
      .from('offering_chapter_cheatsheets')
      .delete().eq('id', (created as { id: string }).id).select('id');
    expect(deleted).toHaveLength(1);
  });

  it('student cannot publish or unpublish offering content', async () => {
    const { error } = await studentClient
      .from('offering_chapter_flashcards')
      .insert({
        offering_id: offeringA, chapter_id: chapterA, published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('offering_chapter_flashcards').delete().eq('id', publishedFlashcards).select();
    expect(deleted).toHaveLength(0);
  });
});
