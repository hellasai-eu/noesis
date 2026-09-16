import { SupabaseClient } from '@supabase/supabase-js';

interface CleanupOptions {
  /** The institution created for the test — cascade-deletes courses, classes, offerings, etc. */
  institutionId: string;
  /** Auth user IDs to delete (removes profiles via trigger/cascade). */
  userIds?: string[];
}

/**
 * Cleans up all test data created during an RLS test suite.
 *
 * Deletion order:
 *  1. user_institutions  (avoids FK issues when institution is deleted)
 *  2. class_enrollments  (avoids FK issues)
 *  3. institution        (cascades to courses → offerings, quizzes, questions, materials, etc.)
 *  4. auth users         (removes profiles via on-delete trigger)
 */
export async function cleanupScaffold(
  admin: SupabaseClient,
  opts: CleanupOptions
): Promise<void> {
  const { institutionId, userIds = [] } = opts;

  // Remove junction rows that reference both the institution and the users
  await admin
    .from('user_institutions')
    .delete()
    .eq('institution_id', institutionId);

  await admin
    .from('class_enrollments')
    .delete()
    .in(
      'class_id',
      // Sub-select: all classes in this institution
      (
        await admin
          .from('classes')
          .select('id')
          .eq('institution_id', institutionId)
      ).data?.map((c) => c.id) ?? []
    );

  // Delete the institution — cascade handles courses, classes, offerings, etc.
  await admin.from('institutions').delete().eq('id', institutionId);

  // Delete auth users (also removes their profiles)
  for (const uid of userIds) {
    await admin.auth.admin.deleteUser(uid);
  }
}
