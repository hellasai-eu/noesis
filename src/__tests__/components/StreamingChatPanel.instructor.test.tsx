import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Telling the teacher apart from the tutor.
 *
 * An instructor can write into a student's session (`role='instructor'`, see
 * OpenQuestionChatHistory). The streaming panel used to fold that row into
 * `assistant` on load, so the teacher's words arrived in the tutor's bubble,
 * under the tutor's avatar — a human's message attributed to the model, which
 * is the one thing a student reading a tutoring transcript must not have to
 * guess about.
 *
 * These tests pin the attribution, not the styling: the role survives the load,
 * and the name of whoever wrote it is on screen.
 */

vi.mock('@/assets/ai-tutor.png', () => ({ default: 'ai-tutor.png' }));

// Interpolates, unlike the simpler stub in the sibling suites: the instructor
// label is `{{name}} · Instructor`, so a `t` that ignored the interpolation
// would let the panel ship the raw template and still pass.
const translation = {
  t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
    const [text, vars] =
      typeof fallback === 'string' ? [fallback, options] : [key, fallback];
    return Object.entries(vars ?? {}).reduce<string>(
      (acc, [name, value]) => acc.split(`{{${name}}}`).join(String(value)),
      text,
    );
  },
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

type MessageRow = {
  id: string;
  role: string;
  content: string;
  sender_user_id: string | null;
  created_at: string;
};

let messageRows: MessageRow[] = [];
let profileRows: { user_id: string; full_name: string | null }[] = [];

vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    let roles: string[] | null = null;
    const rows = () => {
      if (table === 'profiles') return profileRows;
      if (table !== 'chat_messages') return [];
      return roles ? messageRows.filter((m) => roles!.includes(m.role)) : messageRows;
    };
    const query = {
      select: () => query,
      insert: () => query,
      single: async () => ({ data: { id: 'msg-new' }, error: null }),
      eq: () => query,
      in: (column: string, values: string[]) => {
        // Only the role filter narrows the transcript; `profiles.user_id` is a
        // different `in` on a different table and must not be read as one.
        if (column === 'role') roles = values;
        return query;
      },
      order: () => query,
      maybeSingle: async () =>
        table === 'chat_sessions'
          ? { data: { id: 'sess-1', status: 'in_progress' }, error: null }
          : { data: null, error: null },
      then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rows(), error: null }),
    };
    return query;
  };
  return {
    supabase: {
      auth: {
        getUser: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }),
        getSession: () =>
          Promise.resolve({ data: { session: { access_token: 't' } }, error: null }),
      },
      from: (table: string) => makeQuery(table),
      channel: () => {
        const ch = {
          on: () => ch,
          subscribe: (cb?: (s: string) => void) => {
            cb?.('SUBSCRIBED');
            return ch;
          },
        };
        return ch;
      },
      removeChannel: () => {},
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    },
  };
});

import { StreamingChatPanel } from '@/components/chat/StreamingChatPanel';

const TUTOR_TEXT = 'Ολοκληρώσαμε την επανάληψη. Καλή συνέχεια στην προετοιμασία σου!';
const INSTRUCTOR_TEXT = 'Congratulations!';

const renderPanel = () =>
  render(
    <StreamingChatPanel
      kind="study_session"
      subjectId="s1"
      courseId="c1"
      heading="Το ελληνικό κράτος 1830-1881"
      onBack={() => {}}
    />,
  );

/** The bubble column a message's text sits in, avatar and label included. */
const rowContaining = (text: string) =>
  screen.getByText(text).closest('.flex.justify-start') as HTMLElement;

beforeEach(() => {
  messageRows = [
    {
      id: 'm1',
      role: 'assistant',
      content: TUTOR_TEXT,
      sender_user_id: null,
      created_at: '2026-09-06T14:10:00Z',
    },
    {
      id: 'm2',
      role: 'instructor',
      content: INSTRUCTOR_TEXT,
      sender_user_id: 'teacher-1',
      created_at: '2026-09-06T14:21:00Z',
    },
  ];
  profileRows = [{ user_id: 'teacher-1', full_name: 'Μαρία Παπαδοπούλου' }];
  // The panel never streams in these tests; failing loudly beats a silent
  // network call quietly resolving to nothing.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no turn should be requested')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingChatPanel: an instructor message is not the tutor', () => {
  it("signs the instructor's message with their name", async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
    expect(screen.getByText('Μαρία Παπαδοπούλου · Instructor')).toBeInTheDocument();
  });

  it('renders it differently from the tutor reply above it', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());

    // The tutor speaks through the avatar image; the instructor must not.
    const tutorRow = rowContaining(TUTOR_TEXT);
    const instructorRow = rowContaining(INSTRUCTOR_TEXT);
    expect(tutorRow.querySelector('img[alt="AI Assistant"]')).not.toBeNull();
    expect(instructorRow.querySelector('img[alt="AI Assistant"]')).toBeNull();

    // And the attribution belongs to that message, not to the one above it.
    expect(instructorRow).toHaveTextContent('Μαρία Παπαδοπούλου · Instructor');
    expect(tutorRow).not.toHaveTextContent('Instructor');
  });

  it('falls back to the plain label when the name cannot be read', async () => {
    // A student may not be able to read the teacher's profile row; the message
    // is still theirs, and must still say so.
    profileRows = [];
    renderPanel();

    await waitFor(() => expect(screen.getByText(INSTRUCTOR_TEXT)).toBeInTheDocument());
    expect(screen.getByText('Instructor')).toBeInTheDocument();
  });
});
