import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Regression cover for #1177.
 *
 * `DialogContent` is `position: fixed` and vertically centred with
 * `translate-y-[-50%]`. Without a viewport-bounded height AND its own scroll
 * container, a form taller than the viewport overflows *both* edges and nothing
 * can bring the bottom back into view — page scrolling does not move a fixed
 * element. That is what made the "Create Institution" submit button permanently
 * unreachable, and what the E2E suite saw as
 * "done scrolling / element is outside of the viewport".
 *
 * These assert the class contract rather than layout, because jsdom does no
 * layout — but the class contract is exactly what was missing.
 */
describe('dialog viewport overflow (#1177)', () => {
  it('DialogContent bounds its height to the viewport and scrolls', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Tall form</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(content.className).toContain('overflow-y-auto');
  });

  it('AlertDialogContent does the same', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Tall confirmation</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const content = screen.getByRole('alertdialog');
    expect(content.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(content.className).toContain('overflow-y-auto');
  });

  it('a caller-supplied max-h still wins over the default', () => {
    render(
      <Dialog open>
        <DialogContent className="max-h-[85vh]">
          <DialogTitle>Custom height</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('max-h-[85vh]');
    expect(content.className).not.toContain('max-h-[calc(100vh-2rem)]');
    // …and it inherits the scroll it never declared, which is the other half of
    // the bug: several callers capped their height but supplied no overflow.
    expect(content.className).toContain('overflow-y-auto');
  });

  it('a caller-supplied overflow still wins over the default', () => {
    render(
      <Dialog open>
        <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden">
          <DialogTitle>Own inner scroll</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('overflow-hidden');
    expect(content.className).not.toContain('overflow-y-auto');
  });
});
