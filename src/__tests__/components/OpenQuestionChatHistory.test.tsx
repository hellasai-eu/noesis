import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('@/integrations/supabase/client', () => {
  return {
    supabase: {
      from: vi.fn(),
      functions: { invoke: vi.fn() },
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'instr-1' } },
          error: null,
        }),
        onAuthStateChange: vi.fn().mockReturnValue({
          data: { subscription: { unsubscribe: vi.fn() } },
        }),
      },
    },
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'instr-1', email: 'i@t.com' },
    profile: { user_id: 'instr-1', full_name: 'Instructor One' },
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/chat', () => ({
  RichContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock('@/lib/latex-utils', () => ({
  formatQuestionText: (s: string) => s,
}));

import OpenQuestionChatHistory from '@/components/OpenQuestionChatHistory';

type MockTables = Record<string, unknown[]>;

function setupSupabaseMock(
  supabase: { from: ReturnType<typeof vi.fn> },
  tables: MockTables,
  /**
   * Rows a write reports back, per table.
   *
   * RLS does not refuse a write with an error — it matches no rows and reports
   * success — so "the policy declined this" is an empty array here, and that is
   * a case the component has to tell apart from "it worked".
   */
  writeReturns: MockTables = {}
) {
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    const methods = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit'];
    let wrote = false;
    for (const m of methods) {
      chain[m] = vi.fn(() => {
        if (m === 'update' || m === 'delete' || m === 'insert') wrote = true;
        return chain;
      });
    }
    chain.single = vi.fn(() =>
      Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null })
    );
    chain.maybeSingle = vi.fn(() =>
      Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null })
    );
    chain.then = vi.fn((cb: (v: { data: unknown; error: null }) => void) =>
      Promise.resolve(
        cb({
          data: wrote ? writeReturns[table] ?? tables[table] ?? [] : tables[table] ?? [],
          error: null,
        })
      )
    );
    return chain;
  });
}

const baseTables: MockTables = {
  open_questions: [],
  study_sessions: [{ id: 'ss1', title: 'Calc Review' }],
  offerings: [{ class_id: 'class-1' }],
  class_enrollments: [{ user_id: 'student-1' }],
  chat_sessions: [],
  chat_messages: [],
  open_question_grades: [],
  profiles: [{ user_id: 'student-1', full_name: 'Test Student', email: 's@t.com' }],
};

describe('OpenQuestionChatHistory tutoring session status badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Paused" badge when the tutoring session is paused', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    setupSupabaseMock(supabase as unknown as { from: ReturnType<typeof vi.fn> }, {
      ...baseTables,
      chat_sessions: [
        {
          id: 'p1',
          user_id: 'student-1',
          study_session_id: 'ss1',
          open_question_id: null,
          status: 'paused',
          completed_at: null,
          created_at: '2026-05-01T00:00:00Z',
        },
      ],
      chat_messages: [
        {
          id: 'msg1',
          session_id: 'p1',
          role: 'user',
          content: 'paused content',
          flagged_offensive: false,
          created_at: '2026-05-01T00:00:00Z',
          sender_user_id: null,
        },
      ],
    });

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Student')).toBeTruthy();
    });

    expect(screen.getByText('⚠️ Paused')).toBeTruthy();
    expect(screen.queryByText('⏳ In Progress')).toBeNull();
  });

  it('renders "In Progress" badge when the session is in progress', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    setupSupabaseMock(supabase as unknown as { from: ReturnType<typeof vi.fn> }, {
      ...baseTables,
      chat_sessions: [
        {
          id: 'p1',
          user_id: 'student-1',
          study_session_id: 'ss1',
          open_question_id: null,
          status: 'in_progress',
          completed_at: null,
          created_at: '2026-05-01T00:00:00Z',
        },
      ],
      chat_messages: [
        {
          id: 'msg1',
          session_id: 'p1',
          role: 'user',
          content: 'hi',
          flagged_offensive: false,
          created_at: '2026-05-01T00:00:00Z',
          sender_user_id: null,
        },
      ],
    });

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Student')).toBeTruthy();
    });

    expect(screen.getByText('⏳ In Progress')).toBeTruthy();
    expect(screen.queryByText('⚠️ Paused')).toBeNull();
  });

  it('renders "Completed" badge when the session is completed', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    setupSupabaseMock(supabase as unknown as { from: ReturnType<typeof vi.fn> }, {
      ...baseTables,
      chat_sessions: [
        {
          id: 'p1',
          user_id: 'student-1',
          study_session_id: 'ss1',
          open_question_id: null,
          status: 'completed',
          completed_at: '2026-05-01T00:00:00Z',
          created_at: '2026-05-01T00:00:00Z',
        },
      ],
      chat_messages: [
        {
          id: 'msg1',
          session_id: 'p1',
          role: 'assistant',
          content: 'done',
          flagged_offensive: false,
          created_at: '2026-05-01T00:00:00Z',
          sender_user_id: null,
        },
      ],
    });

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Student')).toBeTruthy();
    });

    expect(screen.getByText('✓ Completed')).toBeTruthy();
    expect(screen.queryByText('⚠️ Paused')).toBeNull();
  });

  it('does not list transcript-less written submissions — those live in Question Answers', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    // `submit-open-answer` records a completion session with no chat turns
    // plus a grade row carrying the written answer. This surface is chats
    // only, so the card must not appear.
    setupSupabaseMock(supabase as unknown as { from: ReturnType<typeof vi.fn> }, {
      ...baseTables,
      open_questions: [{ id: 'q1', question: 'Why?' }],
      chat_sessions: [
        {
          id: 'sess-written',
          user_id: 'student-1',
          study_session_id: null,
          open_question_id: 'q1',
          status: 'completed',
          completed_at: '2026-05-01T00:00:00Z',
          created_at: '2026-05-01T00:00:00Z',
        },
      ],
      chat_messages: [],
      open_question_grades: [
        {
          open_question_id: 'q1',
          user_id: 'student-1',
          grade: null,
          feedback: null,
          strengths: [],
          areas_for_improvement: [],
          graded_at: '2026-05-01T00:00:00Z',
          submitted_answer: 'My written answer',
        },
      ],
    });

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('No chat sessions found')).toBeTruthy();
    });
    expect(screen.queryByText('Test Student')).toBeNull();
  });

  it('keeps a paused session visible even with no visible messages', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    // A failed moderation-record write can leave a paused session with an
    // empty transcript; hiding it would hide the only unpause control.
    setupSupabaseMock(supabase as unknown as { from: ReturnType<typeof vi.fn> }, {
      ...baseTables,
      chat_sessions: [
        {
          id: 'sess-paused-empty',
          user_id: 'student-1',
          study_session_id: 'ss1',
          open_question_id: null,
          status: 'paused',
          completed_at: null,
          created_at: '2026-05-01T00:00:00Z',
        },
      ],
      chat_messages: [],
    });

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Student')).toBeTruthy();
    });
    expect(screen.getByText('⚠️ Paused')).toBeTruthy();
  });

  it('renders Paused badge and Unpause Session button for paused question sessions', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    setupSupabaseMock(supabase as unknown as { from: ReturnType<typeof vi.fn> }, {
      ...baseTables,
      open_questions: [{ id: 'q1', question: 'Why?' }],
      chat_sessions: [
        {
          id: 'sess-q1',
          user_id: 'student-1',
          study_session_id: null,
          open_question_id: 'q1',
          status: 'paused',
          completed_at: null,
          created_at: '2026-05-01T00:00:00Z',
        },
      ],
      chat_messages: [
        {
          id: 'c1',
          session_id: 'sess-q1',
          role: 'user',
          content: 'my answer',
          flagged_offensive: false,
          created_at: '2026-05-01T00:00:00Z',
          sender_user_id: null,
        },
      ],
    });

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Student')).toBeTruthy();
    });

    // Paused badge in the accordion trigger
    expect(screen.getByText('⚠️ Paused')).toBeTruthy();

    // Expand the accordion to reveal action buttons
    fireEvent.click(screen.getByText('Test Student'));

    await waitFor(() => {
      expect(screen.getByText('Unpause Session')).toBeTruthy();
    });
  });
});

/*
  An unpause the database refused must not be reported as one that happened.

  A policy declines a write by matching no rows, not by raising — so the update
  comes back `{ data: [], error: null }`, which the handler used to log to the
  console and follow with a "Session unpaused" toast. That is how an instructor
  came to believe they had released a pupil's tutoring session that was still
  paused, and it hid the underlying bug: study-tutor sessions carried no
  `offering_id`, so the section-scoped write policies refused every
  section-restricted instructor while admitting every admin.
*/
describe('OpenQuestionChatHistory unpause reports what actually happened', () => {
  const pausedTutoringTables: MockTables = {
    ...baseTables,
    chat_sessions: [
      {
        id: 'sess-1',
        user_id: 'student-1',
        study_session_id: 'ss1',
        open_question_id: null,
        status: 'paused',
        completed_at: null,
        created_at: '2026-05-01T00:00:00Z',
      },
    ],
    chat_messages: [
      {
        id: 'msg1',
        session_id: 'sess-1',
        role: 'user',
        content: 'paused content',
        flagged_offensive: true,
        created_at: '2026-05-01T00:00:00Z',
        sender_user_id: null,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function clickUnpause(writeReturns: MockTables) {
    const { supabase } = await import('@/integrations/supabase/client');
    setupSupabaseMock(
      supabase as unknown as { from: ReturnType<typeof vi.fn> },
      pausedTutoringTables,
      writeReturns
    );

    render(<OpenQuestionChatHistory courseId="c1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Student')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Test Student'));

    const button = await screen.findByText('Unpause Session');
    fireEvent.click(button);
  }

  it('surfaces an error when the write is refused rather than claiming success', async () => {
    const { toast } = await import('sonner');

    await clickUnpause({ chat_sessions: [] });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(
      /permission/i
    );
  });

  it('reports success when a row really was updated', async () => {
    const { toast } = await import('sonner');

    await clickUnpause({ chat_sessions: [{ id: 'sess-1', status: 'in_progress' }] });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Session unpaused');
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
