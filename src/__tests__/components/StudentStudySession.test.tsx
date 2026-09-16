import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

// Track supabase calls per table for assertions
const fromCalls: Record<string, { method: string; args: unknown[] }[]> = {};

function trackCall(table: string, method: string, ...args: unknown[]) {
  if (!fromCalls[table]) fromCalls[table] = [];
  fromCalls[table].push({ method, args });
}

/*
  These exercise the buffered chat view, which students no longer reach —
  `USE_STREAMING_CHAT` sends them to `StreamingChatPanel` instead.

  Pinned to `false` rather than deleted, deliberately. That path is kept in the
  tree as the one-line revert if streaming has to be pulled, and a revert switch
  nobody tests is not a revert switch: it would rot silently and be discovered
  broken at exactly the moment it was needed. `StreamingChatPanel.*.test.tsx`
  covers the surface students actually get.
*/
vi.mock('@/lib/chat-surface', () => ({ USE_STREAMING_CHAT: false }));

const mockMaybeSingle = vi.fn();
const mockSingle = vi.fn();

vi.mock('@/integrations/supabase/client', () => {
  const createChain = (table: string) => {
    const chain: Record<string, AnyMock> = {};
    const methods = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit'];
    for (const m of methods) {
      chain[m] = vi.fn((...args: unknown[]) => {
        trackCall(table, m, ...args);
        return chain;
      });
    }
    chain.single = vi.fn(() => {
      trackCall(table, 'single');
      return mockSingle();
    });
    chain.maybeSingle = vi.fn(() => {
      trackCall(table, 'maybeSingle');
      return mockMaybeSingle();
    });
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => createChain(table)),
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1' } },
          error: null,
        }),
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'test-token' } },
          error: null,
        }),
        onAuthStateChange: vi.fn().mockReturnValue({
          data: { subscription: { unsubscribe: vi.fn() } },
        }),
      },
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async (path: string) => ({
            data: { signedUrl: `https://signed.example/${path}` },
            error: null,
          })),
        })),
      },
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
      })),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

vi.mock('@/components/chat', async () => {
  const { useState } = await import('react');
  return {
  ChatWidget: ({ disabled, placeholder, messages, onSendMessage }: {
    disabled?: boolean;
    placeholder?: string;
    messages?: { role: string; content: string }[];
    onSendMessage?: (msg: string) => void;
  }) => (
    <div data-testid="chat-widget" data-disabled={disabled} data-placeholder={placeholder}>
      {messages?.map((m, i) => (
        <div key={i} data-testid={`message-${m.role}`}>{m.content}</div>
      ))}
      <button data-testid="mock-send" onClick={() => onSendMessage?.('test message')}>Send</button>
    </div>
  ),
  useChatStreaming: () => ({
    displayedContent: '',
    isTyping: false,
    addToQueue: vi.fn(),
    beginTyping: vi.fn(),
    finishTyping: vi.fn().mockResolvedValue(undefined),
    resetTyping: vi.fn(),
  }),
  // Mirrors the real hook closely enough for these tests: state plus the
  // timestamp stamping every message goes through.
  useChatMessages: (initial: { role: string; content: string }[] = []) =>
    useState(initial.map((m) => ({ timestamp: new Date(), ...m }))),
  formatMessageTime: () => '12:00',
  ChatMessage: {} as unknown,
  RichContent: ({ content }: { content: string }) => <span>{content}</span>,
  ChatAttachments: ({ attachments }: { attachments: { id: string; name: string }[] }) => (
    <div data-testid="chat-attachments">
      {attachments.map((a) => (
        <span key={a.id} data-testid="chat-attachment">{a.name}</span>
      ))}
    </div>
  ),
  };
});

import { StudentStudySession } from '@/components/StudentStudySession';

type SupabaseMockOptions = {
  sessions?: unknown[];
  /** `course_materials` rows the reference-image lookup resolves against. */
  materials?: unknown[];
  progressData?: unknown[];
  messagesData?: unknown[];
  profilesData?: unknown[];
  progressMaybeSingle?: { id: string; status: string; started_at: string; completed_at: null } | null;
  singleData?: { extracted_content: string } | null;
  /** `offering_study_sessions` rows, for the offering-scoped session list. */
  offeringSessions?: unknown[];
};

/**
 * A callable mock.
 *
 * `AnyMock` is `Mock<Procedure | Constructable>` under Vitest 4,
 * which TypeScript will not call or assign to a function type. Supplying the
 * signature explicitly is what makes the harness below type-check.
 */
type AnyMock = Mock<(...args: unknown[]) => unknown>;

function setupSupabaseMock(
  supabase: { from: unknown },
  opts: SupabaseMockOptions = {}
) {
  const {
    sessions = [],
    materials = [],
    progressData = [],
    messagesData = [],
    profilesData = [],
    progressMaybeSingle = null,
    singleData = null,
    offeringSessions = [],
  } = opts;

  (supabase.from as AnyMock).mockImplementation((table: string) => {
    const chain: Record<string, AnyMock> = {};
    const methods = ['insert', 'update', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit', 'select'];
    for (const m of methods) {
      // Recorded, not just chained: what a write puts in the row is the thing
      // some of these tests are about.
      chain[m] = vi.fn((...args: unknown[]) => {
        trackCall(table, m, ...args);
        return chain;
      });
    }
    chain.single = vi.fn(() => Promise.resolve({ data: singleData, error: null }));
    chain.maybeSingle = vi.fn(() => {
      if (table === 'chat_sessions') {
        return Promise.resolve({ data: progressMaybeSingle, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    chain.then = vi.fn((cb: (v: { data: unknown; error: null }) => void) => {
      if (table === 'study_sessions') return Promise.resolve(cb({ data: sessions, error: null }));
      if (table === 'chat_sessions') return Promise.resolve(cb({ data: progressData, error: null }));
      if (table === 'chat_messages') return Promise.resolve(cb({ data: messagesData, error: null }));
      if (table === 'profiles') return Promise.resolve(cb({ data: profilesData, error: null }));
      if (table === 'course_materials') return Promise.resolve(cb({ data: materials, error: null }));
      if (table === 'offering_study_sessions') {
        return Promise.resolve(cb({ data: offeringSessions, error: null }));
      }
      return Promise.resolve(cb({ data: [], error: null }));
    });

    return chain;
  });
}

describe('StudentStudySession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(fromCalls).forEach(key => delete fromCalls[key]);
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockSingle.mockResolvedValue({ data: null, error: null });
  });

  it('renders session list on load', async () => {
    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Tutoring Sessions')).toBeTruthy();
    });
  });

  /*
    A new session names the offering it is being taken under.

    `chat_sessions.offering_id` is what the section-scoped write policies decide
    on. A row that names none is one no section-restricted instructor may
    unpause, delete or reply into — which is how every study-tutor session used
    to be created, so an instructor who took one section of a course could read
    a pupil's tutoring and do nothing about it, while an admin could. The
    student cannot lie about it: their own INSERT policy runs the value through
    `student_may_attribute_to_offering`.
  */
  it('creates the session scoped to the offering it was opened from', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    setupSupabaseMock(supabase, {
      offeringSessions: [
        {
          study_session_id: 's1',
          published_at: '2026-01-01T00:00:00Z',
          study_sessions: { id: 's1', title: 'Session One', student_notes: null, reference_images: null },
        },
      ],
      progressMaybeSingle: null,
      singleData: { extracted_content: 'test' },
    });

    render(<StudentStudySession courseId="c1" offeringId="off-1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Session One')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Session One'));

    await waitFor(() => {
      expect(fromCalls['chat_sessions']?.some(c => c.method === 'insert')).toBe(true);
    });

    const insert = fromCalls['chat_sessions'].find(c => c.method === 'insert')!;
    expect(insert.args[0]).toMatchObject({
      study_session_id: 's1',
      course_id: 'c1',
      offering_id: 'off-1',
    });
  });

  it('loads and preserves messages when returning to a paused session', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    const sessions = [{ id: 's1', title: 'Session One', topic: 'Topic 1', student_notes: null }];
    const progressData = [{ id: 'prog-1', study_session_id: 's1', status: 'paused' }];
    const messagesData = [
      { role: 'assistant', content: 'Welcome to the session!' },
      { role: 'user', content: 'This is a flagged message' },
    ];

    setupSupabaseMock(supabase, {
      sessions,
      progressData,
      messagesData,
      progressMaybeSingle: { id: 'prog-1', status: 'paused', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      singleData: { extracted_content: 'test' },
    });

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('View (Paused)')).toBeTruthy();
    });

    // Click the flagged session to open it
    fireEvent.click(screen.getByText('Session One'));

    // Should show the flagged session with messages preserved
    await waitFor(() => {
      expect(screen.getByText('Welcome to the session!')).toBeTruthy();
      expect(screen.getByText('This is a flagged message')).toBeTruthy();
    });

    // Chat should be disabled
    const chatWidget = screen.getByTestId('chat-widget');
    expect(chatWidget.getAttribute('data-disabled')).toBe('true');
    expect(chatWidget.getAttribute('data-placeholder')).toBe('Session paused - contact instructor');
  });

  /*
    The instructor's reference images are the student's attachments now: the
    tutor is never told they exist and does not choose when they appear, so the
    only thing that can put them on screen is this component reading the session
    row. A regression here is silent — the chat still works, the images simply
    never show.
  */
  /*
    The instructor's reference images are the student's attachments now: the
    tutor is never told they exist and does not choose when they appear, so the
    only thing that can put them on screen is this component reading the session
    row. A regression here is silent — the chat still works, the images simply
    never show.

    The stored entry is a snapshot, so it is resolved against the live material
    rows rather than trusted: an image rejected by a later moderation pass, or
    deleted outright, must stop appearing, and nothing rewrites the sessions
    that reference it.
  */
  it('shows the session reference images as openable attachments', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    const sessions = [{
      id: 's1',
      title: 'Session One',
      topic: 'Topic 1',
      student_notes: null,
      reference_images: [
        { url: 'https://stale.example/expired', storagePath: 'images/europe.png', imageId: 'img-1', name: 'Stale name' },
        // No imageId: the shape written before the material id was stored.
        { url: 'https://stale.example/also-expired', storagePath: 'images/treaty.png', name: 'Treaty' },
        // Rejected on a later moderation pass, or deleted — absent from the
        // approved rows below, so it must not reach the student.
        { url: 'https://stale.example/gone', storagePath: 'images/rejected.png', imageId: 'img-9', name: 'Rejected' },
      ],
    }];

    setupSupabaseMock(supabase, {
      sessions,
      materials: [
        { id: 'img-1', title: 'Europe 1815', file_name: 'europe.png', file_url: 'images/europe.png' },
        { id: 'img-2', title: null, file_name: 'treaty.png', file_url: 'images/treaty.png' },
      ],
      progressMaybeSingle: { id: 'prog-1', status: 'in_progress', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      singleData: { extracted_content: 'test' },
    });

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Session One')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Session One'));

    await waitFor(() => {
      expect(screen.getAllByTestId('chat-attachment').length).toBe(2);
    });
    const names = screen.getAllByTestId('chat-attachment').map((el) => el.textContent);
    // The material's current title, not the name copied into the session row.
    expect(names).toEqual(['Europe 1815', 'treaty.png']);
  });

  it('surfaces instructor messages in the student chat view', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    const sessions = [{ id: 's1', title: 'Session One', topic: 'Topic 1', student_notes: null }];
    const progressData = [{ id: 'prog-1', study_session_id: 's1', status: 'paused' }];
    const messagesData = [
      { id: 'm1', role: 'assistant', content: 'Welcome!', sender_user_id: null, created_at: '2026-04-19T10:00:00Z' },
      { id: 'm2', role: 'user', content: 'My answer', sender_user_id: null, created_at: '2026-04-19T10:01:00Z' },
      { id: 'm3', role: 'instructor', content: 'Try again', sender_user_id: 'instr-1', created_at: '2026-04-19T10:02:00Z' },
    ];
    const profilesData = [{ user_id: 'instr-1', full_name: 'Prof. Papadopoulos' }];

    setupSupabaseMock(supabase, {
      sessions,
      progressData,
      messagesData,
      profilesData,
      progressMaybeSingle: { id: 'prog-1', status: 'paused', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      singleData: { extracted_content: 'test' },
    });

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('View (Paused)')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Session One'));

    await waitFor(() => {
      expect(screen.getByTestId('message-instructor')).toBeTruthy();
      expect(screen.getByText('Try again')).toBeTruthy();
    });
  });

  it('shows "View (Paused)" button for sessions with status="paused" in session list', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    const sessions = [{ id: 's1', title: 'Session One', topic: 'Topic 1', student_notes: null }];
    const progressData = [{ id: 'prog-1', study_session_id: 's1', status: 'paused' }];

    setupSupabaseMock(supabase, { sessions, progressData });

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('View (Paused)')).toBeTruthy();
    });

    const pausedElements = screen.getAllByText(/Paused/);
    expect(pausedElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows content-moderation banner when streaming path returns content_blocked', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    const sessions = [{ id: 's1', title: 'Session One', topic: 'Topic 1', student_notes: null }];
    const progressData = [{ id: 'prog-1', study_session_id: 's1', status: 'in_progress' }];
    const messagesData = [{ role: 'assistant', content: 'Welcome!' }];

    setupSupabaseMock(supabase, {
      sessions,
      progressData,
      messagesData,
      progressMaybeSingle: { id: 'prog-1', status: 'in_progress', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      singleData: { extracted_content: 'test' },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ error: 'content_blocked', message: 'Your message was flagged.' }),
    } as unknown as Response);

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Session One')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Session One'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-send')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('mock-send'));

    await waitFor(() => {
      expect(screen.getByText(/due to content moderation/i)).toBeTruthy();
    });

    // Ensure the instructor-review copy is NOT shown
    expect(screen.queryByText(/paused for instructor review/i)).toBeNull();

    fetchSpy.mockRestore();
  });

  it('disables chat and shows instructor-review banner when status="paused"', async () => {
    const { supabase } = await import('@/integrations/supabase/client');

    const sessions = [{ id: 's1', title: 'Session One', topic: 'Topic 1', student_notes: null }];
    const progressData = [{ id: 'prog-1', study_session_id: 's1', status: 'paused' }];
    const messagesData = [
      { role: 'assistant', content: 'Welcome to the session!' },
      { role: 'user', content: 'A prior student message' },
    ];

    setupSupabaseMock(supabase, {
      sessions,
      progressData,
      messagesData,
      progressMaybeSingle: { id: 'prog-1', status: 'paused', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      singleData: { extracted_content: 'test' },
    });

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('View (Paused)')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Session One'));

    await waitFor(() => {
      expect(screen.getByText('Welcome to the session!')).toBeTruthy();
    });

    const chatWidget = screen.getByTestId('chat-widget');
    expect(chatWidget.getAttribute('data-disabled')).toBe('true');
    expect(chatWidget.getAttribute('data-placeholder')).toBe('Session paused - contact instructor');

    // Paused sessions loaded from history default to the instructor-review
    // banner copy. The content-moderation copy is now driven from the
    // response payload (content_blocked), not from the status literal.
    expect(screen.getByText(/paused for instructor review/i)).toBeTruthy();
    expect(screen.queryByText(/due to content moderation/i)).toBeNull();
  });
});

describe('StudentStudySession — timeout retry must not duplicate the student turn (#1039)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(fromCalls).forEach(key => delete fromCalls[key]);
  });

  it('re-asks the tutor without inserting a second user row', async () => {
    const { supabase } = await import('@/integrations/supabase/client');
    const { toast } = await import('sonner');

    setupSupabaseMock(supabase, {
      sessions: [{ id: 's1', title: 'Session One', topic: 'Topic 1', student_notes: null }],
      progressData: [{ id: 'prog-1', study_session_id: 's1', status: 'in_progress' }],
      // Ends on a user turn: the tutor never answered, so a retry should re-ask.
      messagesData: [{ role: 'user', content: 'test message' }],
      progressMaybeSingle: { id: 'prog-1', status: 'in_progress', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      singleData: { extracted_content: 'test' },
    });

    // Count only the student's own persisted turns.
    const baseFrom = (supabase.from as AnyMock).getMockImplementation()!;
    let userInserts = 0;
    (supabase.from as AnyMock).mockImplementation((table: string) => {
      const chain = baseFrom(table) as Record<string, AnyMock>;
      if (table === 'chat_messages') {
        const original = chain.insert;
        chain.insert = vi.fn((payload: { role?: string }) => {
          if (payload?.role === 'user') userInserts++;
          return original(payload);
        });
      }
      return chain;
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));

    render(<StudentStudySession courseId="c1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Session One')).toBeTruthy());
    fireEvent.click(screen.getByText('Session One'));
    await waitFor(() => expect(screen.getByTestId('mock-send')).toBeTruthy());

    fireEvent.click(screen.getByTestId('mock-send'));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
    expect(userInserts).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The toast must offer a retry rather than telling the student to re-send.
    const timeoutCall = vi
      .mocked(toast.error)
      .mock.calls.find(([, opts]) => (opts as { action?: unknown } | undefined)?.action);
    expect(timeoutCall).toBeTruthy();
    const action = (
      timeoutCall![1] as unknown as { action: { onClick: () => void } }
    ).action;

    action.onClick();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    // The whole point: the retry re-invoked the tutor, it did not re-post the turn.
    expect(userInserts).toBe(1);

    fetchSpy.mockRestore();
  });
});
