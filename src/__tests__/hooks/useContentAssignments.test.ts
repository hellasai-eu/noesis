import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { compareText } from '@/i18n/formatters';

interface Row {
  question_id: string;
  offering_id: string;
  published_at: string | null;
  group_id: string | null;
}

interface GroupRow {
  id: string;
  offering_id: string;
  name: string;
  description: string | null;
  is_individual?: boolean;
  owner_user_id?: string | null;
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

const state: {
  rows: Row[];
  groups: GroupRow[];
  profiles: ProfileRow[];
  /** When set, the assignment SELECT fails with this error instead of returning rows. */
  assignmentsError: { message: string } | null;
  /**
   * Per-call scripting of the assignment SELECT, indexed by call order, so a
   * test can make an earlier fetch slow and failing while a later one is fast
   * and successful.
   */
  assignmentPlan: Array<{ error?: { message: string }; delayMs?: number }>;
} = {
  rows: [],
  groups: [],
  profiles: [],
  assignmentsError: null,
  assignmentPlan: [],
};

/** How many assignment SELECTs have been issued, so `assignmentPlan` can index them. */
let assignmentSelectCount = 0;

const upsertSpy = vi.fn();
const insertSpy = vi.fn();
const deleteSpy = vi.fn();

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/integrations/supabase/client', () => {
  function selectChain(table: string, _columns: string) {
    const chain: any = {};
    const filters: { offering_ids?: string[]; content_ids?: string[]; user_ids?: string[] } = {};
    chain.in = vi.fn((col: string, vals: string[]) => {
      if (col === 'offering_id') filters.offering_ids = vals;
      else if (col === 'question_id') filters.content_ids = vals;
      else if (col === 'user_id') filters.user_ids = vals;
      return chain;
    });
    chain.eq = vi.fn(() => chain);
    chain.then = (cb: any) => {
      if (table === 'offering_questions') {
        const step = state.assignmentPlan[assignmentSelectCount++];
        const err = step?.error ?? state.assignmentsError;
        let data = state.rows;
        if (filters.offering_ids) data = data.filter(r => filters.offering_ids!.includes(r.offering_id));
        if (filters.content_ids) data = data.filter(r => filters.content_ids!.includes(r.question_id));
        const result = err ? { data: null, error: err } : { data, error: null };
        if (step?.delayMs) {
          return new Promise(res => setTimeout(() => res(result), step.delayMs)).then(cb);
        }
        return Promise.resolve(result).then(cb);
      }
      if (table === 'offering_groups') {
        let data = state.groups;
        if (filters.offering_ids) data = data.filter(g => filters.offering_ids!.includes(g.offering_id));
        return Promise.resolve({ data, error: null }).then(cb);
      }
      if (table === 'profiles') {
        let data = state.profiles;
        if (filters.user_ids) data = data.filter(p => filters.user_ids!.includes(p.user_id));
        return Promise.resolve({ data, error: null }).then(cb);
      }
      return Promise.resolve({ data: [], error: null }).then(cb);
    };
    return chain;
  }

  function deleteChain(table: string) {
    const filters: { content_id?: string; offering_id?: string; group_id?: string | null | undefined } = {};
    const chain: any = {};
    chain.eq = vi.fn((col: string, val: any) => {
      if (col === 'question_id') filters.content_id = val;
      else if (col === 'offering_id') filters.offering_id = val;
      else if (col === 'group_id') filters.group_id = val;
      return chain;
    });
    chain.is = vi.fn((col: string, val: any) => {
      if (col === 'group_id' && val === null) filters.group_id = null;
      return chain;
    });
    chain.then = (cb: any) => {
      const before = state.rows.length;
      state.rows = state.rows.filter(r => {
        if (filters.content_id && r.question_id !== filters.content_id) return true;
        if (filters.offering_id && r.offering_id !== filters.offering_id) return true;
        if (filters.group_id !== undefined && (r.group_id ?? null) !== filters.group_id) return true;
        return false;
      });
      deleteSpy({ table, removed: before - state.rows.length, filters });
      return Promise.resolve({ data: null, error: null }).then(cb);
    };
    return chain;
  }

  return {
    supabase: {
      from: (table: string) => ({
        select: (cols: string) => selectChain(table, cols),
        upsert: (row: any, opts: any) => {
          upsertSpy({ table, row, opts });
          const existing = state.rows.findIndex(r =>
            r.question_id === row.question_id &&
            r.offering_id === row.offering_id &&
            (r.group_id ?? null) === (row.group_id ?? null)
          );
          if (existing >= 0) {
            state.rows[existing] = { ...state.rows[existing], ...row, group_id: row.group_id ?? null };
          } else {
            state.rows.push({
              question_id: row.question_id,
              offering_id: row.offering_id,
              published_at: row.published_at ?? null,
              group_id: row.group_id ?? null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert: (rows: any) => {
          insertSpy({ table, rows });
          return Promise.resolve({ data: null, error: null });
        },
        delete: () => deleteChain(table),
      }),
    },
  };
});

import { useContentAssignments, getTableName, getIdColumnName } from '@/hooks/useContentAssignments';
import { CONTENT_TYPES } from '@/types/content-assignments';
import type { ContentType, CourseClass } from '@/types/content-assignments';

const classes: CourseClass[] = [
  { id: 'cls-1', name: 'C1', grade_level_id: null, section_name: null, category: null, academic_period: null, offering_id: 'off-1' },
];

beforeEach(() => {
  state.rows = [];
  state.groups = [{ id: 'g-1', offering_id: 'off-1', name: 'Advanced', description: null, is_individual: false, owner_user_id: null }];
  state.profiles = [];
  state.assignmentsError = null;
  state.assignmentPlan = [];
  assignmentSelectCount = 0;
  upsertSpy.mockClear();
  insertSpy.mockClear();
  deleteSpy.mockClear();
});

describe('useContentAssignments', () => {
  it('saves a whole-class assignment with group_id = null (legacy Set input)', async () => {
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.saveAssignments(['q-1'], new Set(['off-1']), false);
    });

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const call = upsertSpy.mock.calls[0][0];
    expect(call.row.offering_id).toBe('off-1');
    expect(call.row.group_id ?? null).toBe(null);
    expect(state.rows[0].group_id).toBe(null);
  });

  it('saves both whole-class + a group target when the dialog selection is used', async () => {
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const selection = {
      kind: 'targets' as const,
      perOffering: new Map([
        ['off-1', { wholeClass: true, groupIds: new Set(['g-1']) }],
      ]),
    };

    await act(async () => {
      await result.current.saveAssignments(['q-1'], selection, false);
    });

    const groupRows = state.rows.filter(r => r.group_id !== null);
    const wholeRows = state.rows.filter(r => r.group_id === null);
    expect(wholeRows.length).toBe(1);
    expect(groupRows.length).toBe(1);
    expect(groupRows[0].group_id).toBe('g-1');
  });

  it('surfaces individual groups with the owner display name from profiles', async () => {
    state.groups = [
      { id: 'g-1', offering_id: 'off-1', name: 'Advanced', description: null, is_individual: false, owner_user_id: null },
      { id: 'ig-1', offering_id: 'off-1', name: '_individual_u-1', description: null, is_individual: true, owner_user_id: 'u-1' },
      { id: 'ig-2', offering_id: 'off-1', name: '_individual_u-2', description: null, is_individual: true, owner_user_id: 'u-2' },
      { id: 'ig-3', offering_id: 'off-1', name: '_individual_u-3', description: null, is_individual: true, owner_user_id: 'u-3' },
    ];
    state.profiles = [
      { user_id: 'u-1', full_name: 'John Bar', email: 'john@example.com' },
      { user_id: 'u-2', full_name: null, email: 'jane@example.com' },
      // u-3 has no profile row → falls back to "Student"
    ];

    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => {
      expect(result.current.groupsByOffering['off-1']?.length).toBe(4);
    });

    const groups = result.current.groupsByOffering['off-1'];
    // Manual groups first, individuals after — alphabetized within each bucket.
    expect(groups[0]).toMatchObject({ id: 'g-1', is_individual: false });
    expect(groups.slice(1).every(g => g.is_individual)).toBe(true);
    const johnGroup = groups.find(g => g.id === 'ig-1');
    expect(johnGroup?.owner_label).toBe('John Bar');
    const janeGroup = groups.find(g => g.id === 'ig-2');
    expect(janeGroup?.owner_label).toBe('jane@example.com');
    const fallbackGroup = groups.find(g => g.id === 'ig-3');
    expect(fallbackGroup?.owner_label).toBe('Student');
    // Within the individual bucket the order matches `compareText` on owner_label.
    const individualLabels = groups.slice(1).map(g => g.owner_label ?? '');
    const expected = [...individualLabels].sort(compareText);
    expect(individualLabels).toEqual(expected);
  });

  it('persists offering_questions.group_id when an individual group is selected', async () => {
    state.groups = [
      { id: 'ig-1', offering_id: 'off-1', name: '_individual_u-1', description: null, is_individual: true, owner_user_id: 'u-1' },
    ];
    state.profiles = [{ user_id: 'u-1', full_name: 'John Bar', email: null }];

    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const selection = {
      kind: 'targets' as const,
      perOffering: new Map([
        ['off-1', { wholeClass: false, groupIds: new Set(['ig-1']) }],
      ]),
    };

    await act(async () => {
      await result.current.saveAssignments(['q-1'], selection, false);
    });

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0].row.group_id).toBe('ig-1');
    expect(state.rows[0].group_id).toBe('ig-1');
  });

  /*
   * The fetch used to log its error and leave `assignments` empty, which every
   * caller then rendered as "assigned to nobody". Callers that warn about an
   * unassigned item need to distinguish a real empty result from a failure.
   */
  it('reports a failed assignment fetch instead of reading as unassigned', async () => {
    state.assignmentsError = { message: 'permission denied for table offering_questions' };
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));

    await waitFor(() => {
      expect(result.current.error).toBe('permission denied for table offering_questions');
    });
    expect(result.current.getAssignedTargets('q-1')).toEqual([]);
  });

  it('clears a previous fetch error once the query succeeds', async () => {
    state.rows = [{ question_id: 'q-1', offering_id: 'off-1', published_at: '2026-01-01', group_id: null }];
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));

    await waitFor(() => {
      expect(result.current.getAssignedTargets('q-1')).toHaveLength(1);
    });
    expect(result.current.error).toBeNull();
  });

  /*
   * The inputs change as the page fills in, so fetches overlap and can finish
   * out of order. A stale failure landing after a newer success would otherwise
   * pin an error alert over assignments that loaded perfectly well.
   */
  it('ignores a stale fetch that fails after a newer one has succeeded', async () => {
    state.rows = [{ question_id: 'q-2', offering_id: 'off-1', published_at: '2026-01-01', group_id: null }];
    // First fetch: slow and failing. Second: immediate and successful.
    state.assignmentPlan = [{ error: { message: 'transient failure' }, delayMs: 50 }, {}];

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useContentAssignments('mcq_question', ids, classes),
      { initialProps: { ids: ['q-1'] } },
    );
    rerender({ ids: ['q-1', 'q-2'] });

    await waitFor(() => {
      expect(result.current.getAssignedTargets('q-2')).toHaveLength(1);
    });

    // Let the superseded request land.
    await act(async () => {
      await new Promise(res => setTimeout(res, 120));
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.getAssignedTargets('q-2')).toHaveLength(1);
  });

  /*
   * The empty-input branch supersedes anything in flight, so the id guard skips
   * that request's `finally` — which makes clearing the spinner this branch's
   * job. Reachable by deleting the last content item mid-fetch.
   */
  it('clears loading when the inputs empty out mid-fetch', async () => {
    state.assignmentPlan = [{ delayMs: 50 }];

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useContentAssignments('mcq_question', ids, classes),
      { initialProps: { ids: ['q-1'] } },
    );
    rerender({ ids: [] });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // The superseded request lands afterwards and must not revive the spinner.
    await act(async () => {
      await new Promise(res => setTimeout(res, 120));
    });
    expect(result.current.loading).toBe(false);
  });

  it('getAssignedOfferingIds only returns whole-class assignments', async () => {
    state.rows = [
      { question_id: 'q-1', offering_id: 'off-1', published_at: '2026-01-01', group_id: null },
      { question_id: 'q-1', offering_id: 'off-1', published_at: '2026-01-01', group_id: 'g-1' },
    ];
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getAssignedOfferingIds('q-1')).toEqual(['off-1']);
    const targets = result.current.getAssignedTargets('q-1');
    expect(targets).toHaveLength(2);
    expect(targets.find(t => t.group_id === 'g-1')).toBeTruthy();
  });

  it('never deletes unpublished (draft) rows on save', async () => {
    // The dialog edits the PUBLISHED set — a draft row (e.g. a quiz follow-up
    // practice assignment awaiting publication) is never displayed, so being
    // unselected must not delete it.
    state.rows = [
      { question_id: 'q-1', offering_id: 'off-1', published_at: '2026-01-01', group_id: null },
      { question_id: 'q-1', offering_id: 'off-1', published_at: null, group_id: 'g-1' },
    ];
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.saveAssignments(['q-1'], new Set(['off-1']), false);
    });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(
      state.rows.find(r => r.group_id === 'g-1' && r.published_at === null),
    ).toBeTruthy();
  });

  it('never publishes an unpublished (draft) row by selecting its target', async () => {
    // Selecting a target whose row exists as a DRAFT must not upsert over it:
    // the upsert would stamp published_at, publishing a follow-up practice
    // draft past the tracking board's generation guard.
    state.rows = [
      { question_id: 'q-1', offering_id: 'off-1', published_at: null, group_id: null },
    ];
    const { result } = renderHook(() => useContentAssignments('mcq_question', ['q-1'], classes));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.saveAssignments(['q-1'], new Set(['off-1']), false);
    });

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(state.rows[0].published_at).toBeNull();
  });
});

/**
 * #977 — these resolvers used to be if-chains ending in a bare
 * `return 'offering_chapter_flashcards'` / `return 'chapter_id'`. Any
 * `ContentType` without an explicit branch silently wrote its assignments into
 * the flashcards table. They are now a total `Record<ContentType, …>`, so an
 * omission is a compile error; these tests pin the runtime values so a *wrong*
 * entry is caught too.
 */
describe('assignment target resolution', () => {
  const expected: Record<ContentType, { table: string; idColumn: string }> = {
    open_question:      { table: 'offering_questions',           idColumn: 'question_id' },
    mcq_question:       { table: 'offering_questions',           idColumn: 'question_id' },
    fill_gaps:          { table: 'offering_questions',           idColumn: 'question_id' },
    ordering:           { table: 'offering_questions',           idColumn: 'question_id' },
    classification:     { table: 'offering_questions',           idColumn: 'question_id' },
    study_session:      { table: 'offering_study_sessions',      idColumn: 'study_session_id' },
    chapter_flashcard:  { table: 'offering_chapter_flashcards',  idColumn: 'chapter_id' },
    chapter_cheatsheet: { table: 'offering_chapter_cheatsheets', idColumn: 'chapter_id' },
    study_guide:        { table: 'offering_study_guides',        idColumn: 'study_guide_id' },
    quiz:               { table: 'offering_quizzes',             idColumn: 'quiz_id' },
  };

  it.each(CONTENT_TYPES)('resolves %s to its own table and id column', (type) => {
    expect(getTableName(type)).toBe(expected[type].table);
    expect(getIdColumnName(type)).toBe(expected[type].idColumn);
  });

  it('covers every ContentType — no member falls through to a default', () => {
    for (const type of CONTENT_TYPES) {
      expect(getTableName(type)).toBeTruthy();
      expect(getIdColumnName(type)).toBeTruthy();
    }
    // CONTENT_TYPES must stay in sync with the union itself: `expected` is a
    // total Record<ContentType, …>, so this catches a member missing from the
    // exported list.
    expect(new Set(CONTENT_TYPES)).toEqual(new Set(Object.keys(expected) as ContentType[]));
  });

  it('does not route study guides to the former flashcards fallback', () => {
    expect(getTableName('study_guide')).not.toBe('offering_chapter_flashcards');
    expect(getIdColumnName('study_guide')).not.toBe('chapter_id');
  });
});
