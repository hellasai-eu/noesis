import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadQuizPerformance,
  loadStudyGuidePerformance,
} from '@/lib/class-performance-surface';

/**
 * Exercises the Class Performance loaders through their real query chains
 * against a filtering stub (same shape as instructor-surface-content.test),
 * pinning the roster's central contract: only items with a PUBLISHED
 * assignment appear — no target and draft-only both drop the row — and a
 * mixed item keeps only its published targets. The page test stubs the
 * roster components, so this filtering lives or dies here.
 */

type Row = Record<string, unknown>;

/**
 * Minimal PostgREST-builder stub: applies `.in`/`.eq` naively to the
 * fixture rows and resolves like the real thenable builder. `.select` and
 * `.order` are pass-throughs — embedded relations live on the fixture rows.
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
      then: (resolve: (res: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: filtered, error: null }),
    };
    return b;
  };
  return { from: (table: string) => builder(tables[table] ?? []) } as unknown as SupabaseClient;
}

const PUBLISHED = '2026-01-10T00:00:00Z';
const CLOSED = '2026-02-01T00:00:00Z';
/** Long past — assignmentIsDone treats a past due date as done. */
const PAST_DUE = '2020-01-01T00:00:00Z';

const klass = (name: string) => ({
  name,
  grade_level_id: null,
  section_name: '1',
  category: null,
});

describe('loadQuizPerformance', () => {
  const quizzes = [
    {
      id: 'q-none',
      course_id: 'c1',
      title: 'No target',
      created_at: '2026-01-04',
      quiz_questions: [{ count: 3 }],
      offering_quizzes: [],
    },
    {
      id: 'q-draft',
      course_id: 'c1',
      title: 'Draft only',
      created_at: '2026-01-03',
      quiz_questions: [{ count: 5 }],
      offering_quizzes: [
        {
          offering_id: 'off-a',
          published_at: null,
          closed_at: null,
          offerings: { classes: klass('Α τμήμα') },
          offering_groups: null,
        },
      ],
    },
    {
      id: 'q-live',
      course_id: 'c1',
      title: 'Published only',
      created_at: '2026-01-02',
      quiz_questions: [{ count: 4 }],
      offering_quizzes: [
        {
          offering_id: 'off-a',
          published_at: PUBLISHED,
          closed_at: null,
          offerings: { classes: klass('Α τμήμα') },
          offering_groups: null,
        },
        {
          offering_id: 'off-b',
          published_at: PUBLISHED,
          closed_at: CLOSED,
          offerings: { classes: klass('Β τμήμα') },
          offering_groups: { name: 'Ομάδα 1' },
        },
      ],
    },
    {
      id: 'q-mixed',
      course_id: 'c1',
      title: 'Mixed',
      created_at: '2026-01-01',
      quiz_questions: [{ count: 2 }],
      offering_quizzes: [
        {
          offering_id: 'off-a',
          published_at: null, // staged draft — must not surface
          closed_at: null,
          offerings: { classes: klass('Α τμήμα') },
          offering_groups: null,
        },
        {
          offering_id: 'off-b',
          published_at: PUBLISHED,
          closed_at: null,
          offerings: { classes: klass('Β τμήμα') },
          offering_groups: null,
        },
      ],
    },
    {
      id: 'q-other-course',
      course_id: 'c2',
      title: 'Other course',
      created_at: '2026-01-01',
      quiz_questions: [{ count: 1 }],
      offering_quizzes: [],
    },
  ];

  it('drops quizzes with no target or only drafts, keeps published ones', async () => {
    const rows = await loadQuizPerformance(fakeSupabase({ quizzes }), 'c1');

    expect(rows.map((r) => r.id)).toEqual(['q-live', 'q-mixed']);
  });

  it('keeps only published targets on a mixed quiz', async () => {
    const rows = await loadQuizPerformance(fakeSupabase({ quizzes }), 'c1');

    const mixed = rows.find((r) => r.id === 'q-mixed')!;
    expect(mixed.targets).toHaveLength(1);
    expect(mixed.targets[0]).toMatchObject({ offeringId: 'off-b', done: false });
  });

  it('labels group targets and marks closed assignments done', async () => {
    const rows = await loadQuizPerformance(fakeSupabase({ quizzes }), 'c1');

    const live = rows.find((r) => r.id === 'q-live')!;
    expect(live.questionCount).toBe(4);
    expect(live.targets).toEqual([
      { label: 'Α τμήμα', offeringId: 'off-a', done: false },
      { label: 'Β τμήμα — Ομάδα 1', offeringId: 'off-b', done: true },
    ]);
  });
});

describe('loadStudyGuidePerformance', () => {
  const labels = { 'off-a': 'Α τμήμα', 'off-b': 'Β τμήμα' };
  const tables = {
    study_guides: [
      { id: 'g-none', course_id: 'c1', title: 'No target' },
      { id: 'g-draft', course_id: 'c1', title: 'Draft only' },
      { id: 'g-live', course_id: 'c1', title: 'Published only' },
      { id: 'g-mixed', course_id: 'c1', title: 'Mixed' },
      { id: 'g-other', course_id: 'c2', title: 'Other course' },
    ],
    offering_study_guides: [
      // g-draft: staged only — must not surface.
      {
        study_guide_id: 'g-draft',
        offering_id: 'off-a',
        group_id: null,
        published_at: null,
        due_date: null,
        closed_at: null,
      },
      // g-live: one live whole-class target, one past-due group target.
      {
        study_guide_id: 'g-live',
        offering_id: 'off-a',
        group_id: null,
        published_at: PUBLISHED,
        due_date: null,
        closed_at: null,
      },
      {
        study_guide_id: 'g-live',
        offering_id: 'off-b',
        group_id: 'grp-1',
        published_at: PUBLISHED,
        due_date: PAST_DUE,
        closed_at: null,
      },
      // g-mixed: a draft and a published row.
      {
        study_guide_id: 'g-mixed',
        offering_id: 'off-a',
        group_id: null,
        published_at: null,
        due_date: null,
        closed_at: null,
      },
      {
        study_guide_id: 'g-mixed',
        offering_id: 'off-b',
        group_id: null,
        published_at: PUBLISHED,
        due_date: null,
        closed_at: CLOSED,
      },
    ],
    offering_groups: [{ id: 'grp-1', name: 'Ομάδα 1' }],
  };

  it('drops guides with no target or only drafts, keeps published ones', async () => {
    const rows = await loadStudyGuidePerformance(fakeSupabase(tables), 'c1', labels);

    expect(rows.map((r) => r.id)).toEqual(['g-live', 'g-mixed']);
  });

  it('keeps only published targets on a mixed guide, done via closed_at', async () => {
    const rows = await loadStudyGuidePerformance(fakeSupabase(tables), 'c1', labels);

    const mixed = rows.find((r) => r.id === 'g-mixed')!;
    expect(mixed.targets).toEqual([
      { label: 'Β τμήμα', offeringId: 'off-b', done: true },
    ]);
  });

  it('labels group targets and treats a past due date as done', async () => {
    const rows = await loadStudyGuidePerformance(fakeSupabase(tables), 'c1', labels);

    const live = rows.find((r) => r.id === 'g-live')!;
    expect(live.targets).toEqual([
      { label: 'Α τμήμα', offeringId: 'off-a', done: false },
      { label: 'Β τμήμα — Ομάδα 1', offeringId: 'off-b', done: true },
    ]);
  });
});
