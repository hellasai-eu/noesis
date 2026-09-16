import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * The attachment tiles a student clicks.
 *
 * `StudentStudySession.test.tsx` covers which images reach this component —
 * that a rejected one is dropped, that the live material name wins. What it
 * cannot cover is the part the student actually operates: the tile opens, and
 * what opens shows the image at full size with a way out to the file itself.
 * That test stubs this component out, so without this one the click path has
 * no coverage at all.
 */

// The real translations are not loaded here; the second argument to `t` is the
// English copy the component ships with, which is what these assertions read.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

import { ChatAttachments } from '@/components/chat/ChatAttachments';

const ATTACHMENTS = [
  { id: 'img-1', name: 'Europe 1815', url: 'https://signed.example/europe.png?token=a' },
  { id: 'img-2', name: 'Treaty of Vienna', url: 'https://signed.example/treaty.png?token=b' },
];

describe('ChatAttachments', () => {
  it('renders nothing when the session has no attachments', () => {
    const { container } = render(<ChatAttachments attachments={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('opens the clicked attachment full size, with a link to the file', () => {
    render(<ChatAttachments attachments={ATTACHMENTS} />);

    // One tile per attachment, each showing its own thumbnail.
    expect(screen.getAllByRole('button').length).toBe(2);

    fireEvent.click(screen.getByTitle('Treaty of Vienna'));

    // The dialog shows the one that was clicked — not the first tile.
    const full = screen.getByAltText('Treaty of Vienna') as HTMLImageElement;
    expect(full.src).toBe(ATTACHMENTS[1].url);

    const link = screen.getByText('Open in a new tab').closest('a') as HTMLAnchorElement;
    expect(link.href).toBe(ATTACHMENTS[1].url);
    // Opened in a new tab, and without handing the file's opener to the page.
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });
});
