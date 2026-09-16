/**
 * Attaching an image in the visual editor (#1217).
 *
 * These run against a REAL tiptap editor, not a stubbed one. The behaviour
 * worth pinning is where the image lands when the author keeps typing during
 * an upload, and a fake view cannot demonstrate that — position mapping is
 * exactly the thing a stub replaces with a constant.
 *
 * Only the network is faked: `uploadContentImage` is resolved by hand so a
 * test can edit the document *while the upload is in flight*.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const uploadContentImage = vi.fn();

vi.mock('@/lib/editor-images', () => ({
  uploadContentImage: (...args: unknown[]) => uploadContentImage(...args),
  IMAGE_ACCEPT_ATTRIBUTE: 'image/png,image/jpeg,image/webp,image/gif',
}));

// The editor imports the supabase client transitively; the real one throws at
// module load without VITE_SUPABASE_*, which CI does not set.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getUser: vi.fn() }, storage: { from: vi.fn() } },
}));

import { CheatSheetEditor } from '@/components/CheatSheetEditor';

const URL_A = 'https://example.supabase.co/storage/v1/object/public/content-images/u/a.webp';

function pngFile(name = 'Rhineland diagram.png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

/** A promise whose resolution this test controls, standing in for the upload. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pickFile(file: File) {
  fireEvent.change(screen.getByTestId('editor-image-input'), { target: { files: [file] } });
}

function proseMirror(): HTMLElement {
  const el = document.querySelector('.ProseMirror');
  if (!el) throw new Error('editor did not mount');
  return el as HTMLElement;
}

describe('CheatSheetEditor image attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadContentImage.mockResolvedValue(URL_A);
  });

  it('offers an insert-image control accepting only the types the bucket allows', () => {
    render(<CheatSheetEditor content="<p>Test</p>" onChange={vi.fn()} />);
    expect(screen.getByTestId('editor-insert-image')).toBeInTheDocument();
    expect(screen.getByTestId('editor-image-input')).toHaveAttribute(
      'accept',
      'image/png,image/jpeg,image/webp,image/gif',
    );
  });

  it('uploads a picked file and puts the returned URL in the document', async () => {
    const onChange = vi.fn();
    render(<CheatSheetEditor content="<p>Before</p>" onChange={onChange} />);

    pickFile(pngFile());

    await waitFor(() => expect(uploadContentImage).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const img = proseMirror().querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe(URL_A);
    });
    // The file name becomes alt text rather than leaving the image unlabelled.
    expect(proseMirror().querySelector('img')?.getAttribute('alt')).toBe('Rhineland diagram');
    expect(onChange).toHaveBeenCalled();
  });

  it('shows a placeholder while the upload is in flight, and clears it after', async () => {
    const pending = deferred<string>();
    uploadContentImage.mockReturnValue(pending.promise);
    render(<CheatSheetEditor content="<p>Before</p>" onChange={vi.fn()} />);

    pickFile(pngFile());

    await waitFor(() =>
      expect(proseMirror().querySelector('.editor-image-placeholder')).not.toBeNull(),
    );

    pending.resolve(URL_A);

    await waitFor(() =>
      expect(proseMirror().querySelector('.editor-image-placeholder')).toBeNull(),
    );
    expect(proseMirror().querySelector('img')).not.toBeNull();
  });

  it('does not disturb the text that was already there', async () => {
    render(<CheatSheetEditor content="<p>Alpha</p><p>Omega</p>" onChange={vi.fn()} />);

    pickFile(pngFile());

    await waitFor(() => expect(proseMirror().querySelector('img')).not.toBeNull());
    expect(proseMirror().textContent).toContain('Alpha');
    expect(proseMirror().textContent).toContain('Omega');
  });

  // NOTE: that the image lands where the upload STARTED — rather than wherever
  // the caret drifted to while it was in flight — is NOT asserted here. jsdom
  // does not move a ProseMirror selection in response to a synthetic click, so
  // a test written at this level passes whether the mapping works or not (it
  // was, and it did, until the mutation was checked). That behaviour is pinned
  // against a real EditorState in imageUploadPlaceholder.test.ts instead.

  it('leaves the document untouched when the upload fails, and stays retryable', async () => {
    uploadContentImage.mockRejectedValue(new Error('That image is over 10MB — try a smaller one'));
    render(<CheatSheetEditor content="<p>Before</p>" onChange={vi.fn()} />);

    pickFile(pngFile());

    await waitFor(() => expect(uploadContentImage).toHaveBeenCalled());
    await waitFor(() =>
      expect(proseMirror().querySelector('.editor-image-placeholder')).toBeNull(),
    );
    expect(proseMirror().querySelector('img')).toBeNull();
    // The button must come back, or a failed upload is unretryable.
    await waitFor(() => expect(screen.getByTestId('editor-insert-image')).not.toBeDisabled());
  });

  it('does nothing at all when the picker is dismissed without a file', async () => {
    render(<CheatSheetEditor content="<p>Before</p>" onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId('editor-image-input'), { target: { files: [] } });
    expect(uploadContentImage).not.toHaveBeenCalled();
  });
});
