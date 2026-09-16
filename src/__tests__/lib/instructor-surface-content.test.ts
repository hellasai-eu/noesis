import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadInstructorContent } from '@/lib/instructor-surface';

/**
 * Exercises `loadInstructorContent` through its real query chains against a
 * filtering stub, so the loader-level contracts are covered rather than
 * assumed by the presentation tests' hand-built summaries:
 *
 * - the embedded PostgREST count shapes (`quiz_questions(count)`,
 *   `study_guide_piece_questions(count)`) are parsed, not just typed away;
 * - assignment and completion reads are BOTH scoped to the instructor's
 *   active offerings — an assignment on an out-of-scope offering must not
 *   count as assigned, or `guideIsAssignable`'s escape hatch hides the
 *   guide's incomplete state from the home shelf.
 */

type Row = Record<string, unknown>;

/**
 * Minimal PostgREST-builder stub: applies `.in`/`.eq`/`.not` naively to the
 * fixture rows and resolves like the real thenable builder. `.select` and
 * `.order` are pass-throughs — embedded count arrays live on the fixture
 * rows themselves.
 */
function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  const builder = (rows: Row[]) => {
    let filtered = rows;
    const b = {
      select: () => b,
      order: () => b,
      in: (col: string, vals: unknown[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      eq: (col: string, v: unknown) => {
        filtered = filtered.filter((r) => r[col] === v);
        return b;
      },
      not: (col: string) => {
        filtered = filtered.filter((r) => r[col] !== null && r[col] !== undefined);
        return b;
      },
      then: (resolve: (res: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: filtered, error: null }),
    };
    return b;
  };
  return { from: (table: string) => builder(tables[table] ?? []) } as unknown as SupabaseClient;
}

const PUBLISHED = '2026-01-10T00:00:00Z';

function fixture() {
  return fakeSupabase({
    course_materials: [{ id: 'm1', course_id: 'c1' }],
    course_competencies: [],
    study_guides: [
      { id: 'g-live', course_id: 'c1', title: 'Live', created_at: '2026-01-03' },
      { id: 'g-partial', course_id: 'c1', title: 'Partial', created_at: '2026-01-02' },
      { id: 'g-stale', course_id: 'c1', title: 'Stale', created_at: '2026-01-01' },
    ],
    quizzes: [
      {
        id: 'q1',
        course_id: 'c1',
        title: 'Quiz',
        created_at: '2026-01-01',
        quiz_questions: [{ count: 4 }],
      },
    ],
    offering_study_guides: [
      // In scope: counts as assigned.
      {
        study_guide_id: 'g-live',
        offering_id: 'off-live',
        published_at: PUBLISHED,
        due_date: null,
        closed_at: null,
      },
      // Published, but on an offering outside the instructor's active scope
      // (e.g. last year's class): must NOT count as assigned.
      {
        study_guide_id: 'g-stale',
        offering_id: 'off-old',
        published_at: PUBLISHED,
        due_date: null,
        closed_at: null,
      },
    ],
    offering_quizzes: [
      { quiz_id: 'q1', offering_id: 'off-live', published_at: PUBLISHED, closed_at: null },
      { quiz_id: 'q1', offering_id: 'off-old', published_at: PUBLISHED, closed_at: null },
    ],
    study_guide_pieces: [
      { study_guide_id: 'g-live', study_guide_piece_questions: [{ count: 3 }] },
      { study_guide_id: 'g-live', study_guide_piece_questions: [{ count: 2 }] },
      { study_guide_id: 'g-partial', study_guide_piece_questions: [{ count: 1 }] },
      // The incomplete piece: PostgREST reports zero links as [{count: 0}].
      { study_guide_id: 'g-partial', study_guide_piece_questions: [{ count: 0 }] },
      // g-stale has no pieces at all.
    ],
    study_guide_progress: [
      {
        study_guide_id: 'g-live',
        offering_id: 'off-live',
        user_id: 's1',
        completed_at: PUBLISHED,
      },
      // Out-of-scope completion: excluded from the badge count.
      {
        study_guide_id: 'g-live',
        offering_id: 'off-old',
        user_id: 's2',
        completed_at: PUBLISHED,
      },
    ],
    quiz_sessions: [
      { quiz_id: 'q1', offering_id: 'off-live', user_id: 's1', status: 'completed' },
      { quiz_id: 'q1', offering_id: 'off-live', user_id: 's3', status: 'in_progress' },
    ],
  });
}

const params = {
  courseIds: ['c1'],
  classNameByOffering: { 'off-live': 'Τμήμα 1Α' },
  classIdByOffering: { 'off-live': 'cls-a' },
};

describe('loadInstructorContent', () => {
  it('parses embedded piece/question counts into completeness numbers', async () => {
    const content = await loadInstructorContent(fixture(), params);
    const byId = Object.fromEntries(content.guides.map((g) => [g.id, g]));

    expect(byId['g-live']).toMatchObject({ pieceCount: 2, incompletePieceCount: 0 });
    expect(byId['g-partial']).toMatchObject({ pieceCount: 2, incompletePieceCount: 1 });
    expect(byId['g-stale']).toMatchObject({ pieceCount: 0, incompletePieceCount: 0 });
    expect(content.quizzes[0].questionCount).toBe(4);
  });

  it('scopes assignment counters to active offerings, matching the completion reads', async () => {
    const content = await loadInstructorContent(fixture(), params);
    const byId = Object.fromEntries(content.guides.map((g) => [g.id, g]));

    expect(byId['g-live']).toMatchObject({
      assignedCount: 1,
      assignedClassNames: ['Τμήμα 1Α'],
      studentsCompleted: 1, // s2's out-of-scope completion is excluded
    });
    // g-stale's only assignment sits on an out-of-scope offering: without the
    // scope it would read "Assigned" here while StudyGuideManager blocks
    // assigning it — the disagreement this test pins down.
    expect(byId['g-stale']).toMatchObject({ assignedCount: 0, studentsCompleted: 0 });
    // The quiz's out-of-scope open assignment is likewise not counted.
    expect(content.quizzes[0]).toMatchObject({ openCount: 1, studentsCompleted: 1 });
  });

  it('returns empty content without querying when the instructor has no courses', async () => {
    const content = await loadInstructorContent(fixture(), {
      courseIds: [],
      classNameByOffering: {},
      classIdByOffering: {},
    });
    expect(content).toEqual({
      materialCountByCourse: {},
      competencyCountByCourse: {},
      guides: [],
      quizzes: [],
    });
  });
});
