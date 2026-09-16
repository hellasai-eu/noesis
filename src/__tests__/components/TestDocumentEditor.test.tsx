import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const chainCalls: Array<{ command: string; args: unknown[] }> = [];

function mockChain(): Record<string, (...args: unknown[]) => unknown> {
  const target: Record<string, (...args: unknown[]) => unknown> = {};
  const proxy: Record<string, (...args: unknown[]) => unknown> = new Proxy(target, {
    get(_target, prop: string) {
      if (prop === 'run') return () => true;
      return (...args: unknown[]) => {
        chainCalls.push({ command: prop, args });
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock('@tiptap/react', () => ({
  useEditor: () => ({
    commands: { setContent: vi.fn() },
    can: vi.fn().mockReturnValue({
      undo: vi.fn().mockReturnValue(true),
      redo: vi.fn().mockReturnValue(true),
    }),
    isActive: vi.fn().mockReturnValue(false),
    getHTML: vi.fn().mockReturnValue('<p>seed</p>'),
    getAttributes: vi.fn().mockReturnValue({}),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: false,
    chain: () => mockChain(),
  }),
  EditorContent: () => <div data-testid="editor-content">Editor</div>,
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: vi.fn().mockReturnValue({}) },
}));
vi.mock('@tiptap/extension-link', () => ({
  default: { configure: vi.fn().mockReturnValue({}) },
}));
vi.mock('@tiptap/extension-text-style', () => ({
  TextStyle: {},
  FontSize: {},
}));
vi.mock('@/components/test-editor/PageBreakExtension', () => ({
  PageBreak: { name: 'pageBreak' },
}));

import { TestDocumentEditor } from '@/components/TestDocumentEditor';

describe('TestDocumentEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainCalls.length = 0;
  });

  it('renders without crashing', () => {
    render(<TestDocumentEditor content="<p>seed</p>" onChange={vi.fn()} />);
    expect(document.body).toBeTruthy();
  });

  it('shows the editor area', () => {
    render(<TestDocumentEditor content="<p>seed</p>" onChange={vi.fn()} />);
    expect(screen.getByTestId('editor-content')).toBeInTheDocument();
  });

  it('exposes a Page break toolbar button that calls insertPageBreak', () => {
    render(<TestDocumentEditor content="" onChange={vi.fn()} />);
    const btn = screen.getByTestId('page-break-button');
    fireEvent.click(btn);
    // The toolbar wires through `chain().focus().insertPageBreak().run()`,
    // so the proxy should have recorded an `insertPageBreak` call.
    expect(chainCalls.some((c) => c.command === 'insertPageBreak')).toBe(true);
  });

  it('exposes a font-size dropdown trigger', () => {
    render(<TestDocumentEditor content="" onChange={vi.fn()} />);
    expect(screen.getByTestId('font-size-select')).toBeInTheDocument();
  });
});
