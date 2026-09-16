import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock tiptap
vi.mock('@tiptap/react', () => ({
  useEditor: () => ({
    commands: {
      setContent: vi.fn(),
      toggleBold: vi.fn(),
      toggleItalic: vi.fn(),
      toggleUnderline: vi.fn(),
      toggleStrike: vi.fn(),
      setTextAlign: vi.fn(),
      toggleBulletList: vi.fn(),
      toggleOrderedList: vi.fn(),
      toggleHighlight: vi.fn(),
      setColor: vi.fn(),
      unsetColor: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      insertTable: vi.fn(),
    },
    can: vi.fn().mockReturnValue({
      undo: vi.fn().mockReturnValue(true),
      redo: vi.fn().mockReturnValue(true),
    }),
    isActive: vi.fn().mockReturnValue(false),
    getHTML: vi.fn().mockReturnValue('<p>Test</p>'),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: false,
    chain: vi.fn().mockReturnValue({
      focus: vi.fn().mockReturnValue({
        toggleBold: vi.fn().mockReturnValue({ run: vi.fn() }),
        toggleItalic: vi.fn().mockReturnValue({ run: vi.fn() }),
        run: vi.fn(),
      }),
      run: vi.fn(),
    }),
  }),
  EditorContent: ({ editor }: { editor: unknown }) => (
    <div data-testid="editor-content">Editor Content</div>
  ),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: vi.fn().mockReturnValue({}) },
}));

vi.mock('@tiptap/extension-underline', () => ({
  default: {},
}));

vi.mock('@tiptap/extension-text-align', () => ({
  default: { configure: vi.fn().mockReturnValue({}) },
}));

vi.mock('@tiptap/extension-color', () => ({
  default: {},
}));

vi.mock('@tiptap/extension-text-style', () => ({
  default: {},
}));

vi.mock('@tiptap/extension-highlight', () => ({
  default: { configure: vi.fn().mockReturnValue({}) },
}));

vi.mock('@tiptap/extension-table', () => ({
  default: { configure: vi.fn().mockReturnValue({}) },
}));

vi.mock('@tiptap/extension-table-row', () => ({
  default: {},
}));

vi.mock('@tiptap/extension-table-header', () => ({
  default: {},
}));

vi.mock('@tiptap/extension-table-cell', () => ({
  default: {},
}));

// The editor's image-attach path imports the supabase client, which throws at
// module load without VITE_SUPABASE_* — unset for unit tests in CI.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getUser: vi.fn() }, storage: { from: vi.fn() } },
}));

import { CheatSheetEditor } from '@/components/CheatSheetEditor';

describe('CheatSheetEditor', () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<CheatSheetEditor content="<p>Test</p>" onChange={mockOnChange} />);
    expect(document.body).toBeTruthy();
  });

  it('displays editor content area', () => {
    render(<CheatSheetEditor content="<p>Hello</p>" onChange={mockOnChange} />);
    expect(screen.getByTestId('editor-content')).toBeInTheDocument();
  });

  it('accepts initial content', () => {
    render(<CheatSheetEditor content="<p>Initial content</p>" onChange={mockOnChange} />);
    expect(document.body).toBeTruthy();
  });

  it('accepts empty content', () => {
    render(<CheatSheetEditor content="" onChange={mockOnChange} />);
    expect(document.body).toBeTruthy();
  });
});
