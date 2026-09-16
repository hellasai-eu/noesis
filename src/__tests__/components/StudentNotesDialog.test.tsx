import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const noteRows = vi.hoisted(() => [
  {
    id: 'n1',
    body: 'Has a peanut allergy.',
    created_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-01T10:00:00Z',
    created_by: 'admin-1',
    updated_by: 'admin-1',
  },
]);

const profileRows = vi.hoisted(() => [
  { user_id: 'admin-1', full_name: 'Anna Admin', email: 'anna@school.edu' },
]);

const insertMock = vi.hoisted(() => vi.fn().mockResolvedValue({ error: null }));
const updateMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

const fromMock = vi.hoisted(() =>
  vi.fn().mockImplementation((table: string) => {
    if (table === 'student_admin_notes') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: noteRows, error: null }),
            }),
          }),
        }),
        insert: insertMock,
        update: updateMock,
        delete: deleteMock,
      };
    }
    if (table === 'profiles') {
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: profileRows, error: null }),
        }),
      };
    }
    return {};
  })
);

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: fromMock,
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'admin-1' } }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { StudentNotesDialog, NOTE_MAX_LENGTH } from '@/components/StudentNotesDialog';
import { formatNumber } from '@/i18n/formatters';

describe('StudentNotesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the timeline with author and body when notes exist (read-only mode)', async () => {
    render(
      <StudentNotesDialog
        open
        onOpenChange={() => {}}
        studentUserId="student-1"
        studentFullName="Stella Student"
        institutionId="inst-1"
        mode="read-only"
      />,
    );

    expect(screen.getByText(/Notes for Stella Student/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Has a peanut allergy.')).toBeInTheDocument();
    });
    expect(screen.getByText('Anna Admin')).toBeInTheDocument();

    // No add-note textarea or write controls in read-only mode
    expect(screen.queryByPlaceholderText(/Add a note/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add note/i })).not.toBeInTheDocument();
  });

  it('shows the character counter and disables submit when over the limit', async () => {
    const user = userEvent.setup();
    render(
      <StudentNotesDialog
        open
        onOpenChange={() => {}}
        studentUserId="student-1"
        studentFullName="Stella Student"
        institutionId="inst-1"
        mode="read-write"
      />,
    );

    const textarea = await screen.findByPlaceholderText(/Add a note/i);
    const addButton = screen.getByRole('button', { name: /Add note/i });

    expect(addButton).toBeDisabled();

    await user.type(textarea, 'A short note');
    expect(addButton).not.toBeDisabled();
    expect(
      screen.getByText(new RegExp(`12 / ${formatNumber(NOTE_MAX_LENGTH)}`)),
    ).toBeInTheDocument();
  });
});
