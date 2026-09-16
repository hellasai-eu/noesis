/**
 * `prepareImageForUpload` and `uploadContentImage` (#1217, #1223).
 *
 * The sibling `editor-images.test.ts` covers `fitWithin` and the sanitizer, and
 * `CheatSheetEditor.images.test.tsx` covers the editor around the upload — but
 * that one mocks `@/lib/editor-images` wholesale, so until this file nothing
 * ran the module's own logic. Two things went untested that matter:
 *
 *  - the validation arms. Type and size are refused with a message meant for a
 *    toast, and both must bite BEFORE the decode, because the point of the size
 *    cap is not to hand a 40MB file to `createImageBitmap`.
 *  - the storage path. `<uid>/<uuid>.<ext>` is not cosmetic: the uid prefix is
 *    exactly what `content-images`' INSERT policy compares against `auth.uid()`
 *    (20260831090000_content_images_bucket.sql). The policy has an RLS test of
 *    its own, but nothing pinned the client to producing a path that policy
 *    accepts — the two could drift apart and both stay green.
 *
 * The browser bits are stubbed rather than run: jsdom ships no canvas and no
 * `createImageBitmap`, so decoding and encoding are the two seams this file
 * drives. That also makes the WebP→PNG fallback reachable, which on a real
 * canvas depends on the host's codec support.
 *
 * Not covered here: the `<img>` + object-URL fallback inside `decodeImage`,
 * which needs a load event jsdom never fires. `createImageBitmap` is present in
 * every browser this app supports, so that arm is the cold path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const supabaseMocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: supabaseMocks.getUser },
    storage: {
      from: (bucket: string) => {
        supabaseMocks.from(bucket);
        return { upload: supabaseMocks.upload, getPublicUrl: supabaseMocks.getPublicUrl };
      },
    },
  },
}));

import {
  CONTENT_IMAGE_BUCKET,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  MAX_SOURCE_BYTES,
  prepareImageForUpload,
  uploadContentImage,
} from '@/lib/editor-images';

const USER_ID = '11111111-2222-3333-4444-555555555555';
/** vitest.setup.ts pins `crypto.randomUUID`, so the path is assertable. */
const UUID = 'test-uuid-12345678';

/**
 * A file whose `size` is set independently of its bytes — a 10MB fixture would
 * cost 10MB of heap per test to prove a comparison.
 */
function imageFile({
  type = 'image/png',
  name = 'diagram.png',
  size = 1024,
}: { type?: string; name?: string; size?: number } = {}) {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

// ── The two browser seams ────────────────────────────────────────────────
const decode = vi.fn();
const close = vi.fn();
const drawImage = vi.fn();
/** What `toBlob` answers for a requested MIME type. Missing ⇒ null. */
let encoders: Record<string, Blob | null> = {};
let encodeRequests: Array<{ type: string; width: number; height: number }> = [];

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

/** Next decode yields an image of this size; `close()` records the release. */
function decodesTo(width: number, height: number) {
  decode.mockResolvedValue({ width, height, close });
}

beforeEach(() => {
  decode.mockReset();
  close.mockReset();
  drawImage.mockReset();
  encodeRequests = [];
  encoders = { 'image/webp': new Blob(['webp'], { type: 'image/webp' }) };
  decodesTo(400, 300);

  globalThis.createImageBitmap = decode as unknown as typeof createImageBitmap;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage,
  })) as unknown as typeof originalGetContext;
  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ) {
    encodeRequests.push({ type: type ?? '', width: this.width, height: this.height });
    callback(encoders[type ?? ''] ?? null);
  };

  supabaseMocks.getUser.mockReset();
  supabaseMocks.upload.mockReset();
  supabaseMocks.getPublicUrl.mockReset();
  supabaseMocks.from.mockReset();
  supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  supabaseMocks.upload.mockResolvedValue({ error: null });
  supabaseMocks.getPublicUrl.mockImplementation((path: string) => ({
    data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/${CONTENT_IMAGE_BUCKET}/${path}` },
  }));
});

afterEach(() => {
  globalThis.createImageBitmap = originalCreateImageBitmap;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
});

describe('prepareImageForUpload — what it refuses', () => {
  it('refuses a type the bucket does not accept, and says which ones it does', async () => {
    await expect(prepareImageForUpload(imageFile({ type: 'image/svg+xml' }))).rejects.toThrow(
      /PNG, JPEG, WebP and GIF/,
    );
  });

  it('refuses a PDF renamed to look like a picture', async () => {
    await expect(
      prepareImageForUpload(imageFile({ type: 'application/pdf', name: 'diagram.png' })),
    ).rejects.toThrow(/PNG, JPEG, WebP and GIF/);
  });

  it('refuses a file over the source cap', async () => {
    await expect(
      prepareImageForUpload(imageFile({ size: MAX_SOURCE_BYTES + 1 })),
    ).rejects.toThrow(/over 10MB/);
  });

  it('accepts a file exactly at the cap — the limit is inclusive', async () => {
    await expect(
      prepareImageForUpload(imageFile({ size: MAX_SOURCE_BYTES })),
    ).resolves.toBeTruthy();
  });

  it('rejects on type and size BEFORE decoding — the cap exists to avoid the decode', async () => {
    await expect(prepareImageForUpload(imageFile({ type: 'image/svg+xml' }))).rejects.toThrow();
    await expect(
      prepareImageForUpload(imageFile({ size: MAX_SOURCE_BYTES + 1 })),
    ).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it('reports an image that decodes to nothing', async () => {
    decodesTo(0, 0);
    await expect(prepareImageForUpload(imageFile())).rejects.toThrow(/could not be decoded/);
  });

  it('reports a canvas that yields no 2D context', async () => {
    decodesTo(4000, 3000);
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null,
    ) as unknown as typeof originalGetContext;
    await expect(prepareImageForUpload(imageFile())).rejects.toThrow(/could not be resized/);
  });

  it('reports a re-encode that produces nothing at all', async () => {
    decodesTo(4000, 3000);
    encoders = {};
    await expect(prepareImageForUpload(imageFile())).rejects.toThrow(/could not be resized/);
  });

  it('releases the decoded bitmap even when the encode fails', async () => {
    decodesTo(4000, 3000);
    encoders = {};
    await expect(prepareImageForUpload(imageFile())).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases the decoded bitmap on the happy path too', async () => {
    decodesTo(4000, 3000);
    await prepareImageForUpload(imageFile());
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('prepareImageForUpload — passthrough vs re-encode', () => {
  it('uploads a small in-box image untouched, without going near a canvas', async () => {
    decodesTo(400, 300);
    const file = imageFile({ size: 20 * 1024 });

    const prepared = await prepareImageForUpload(file);

    expect(prepared.blob).toBe(file);
    expect(prepared).toMatchObject({
      contentType: 'image/png',
      extension: 'png',
      width: 400,
      height: 300,
    });
    expect(encodeRequests).toEqual([]);
  });

  it('leaves a small animated GIF alone rather than flattening it to frame one', async () => {
    decodesTo(300, 300);
    const gif = imageFile({ type: 'image/gif', name: 'orbit.gif', size: 100 * 1024 });

    const prepared = await prepareImageForUpload(gif);

    expect(prepared.blob).toBe(gif);
    expect(prepared.extension).toBe('gif');
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('re-encodes an in-box image that is nonetheless heavy', async () => {
    decodesTo(400, 300);

    const prepared = await prepareImageForUpload(imageFile({ size: 900 * 1024 }));

    // Same box — it already fitted — but the bytes went through the canvas.
    expect(prepared).toMatchObject({ contentType: 'image/webp', width: 400, height: 300 });
    expect(encodeRequests[0]).toMatchObject({ width: 400, height: 300 });
  });

  it('scales a phone photo into the box and re-encodes it as WebP', async () => {
    decodesTo(4000, 2000);

    const prepared = await prepareImageForUpload(
      imageFile({ type: 'image/jpeg', name: 'photo.jpg', size: 4 * 1024 * 1024 }),
    );

    expect(prepared).toMatchObject({
      contentType: 'image/webp',
      extension: 'webp',
      width: 1200,
      height: 600,
    });
    expect(prepared.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
    expect(prepared.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    // The canvas is the target size, not the source's 4000x2000.
    expect(encodeRequests[0]).toMatchObject({ width: 1200, height: 600 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1200, 600);
  });

  it('falls back to PNG when the host cannot encode WebP', async () => {
    decodesTo(4000, 3000);
    // Some hosts answer a WebP request with a PNG instead of refusing.
    encoders = {
      'image/webp': new Blob(['png'], { type: 'image/png' }),
      'image/png': new Blob(['png'], { type: 'image/png' }),
    };

    const prepared = await prepareImageForUpload(imageFile());

    expect(prepared).toMatchObject({ contentType: 'image/png', extension: 'png' });
    expect(encodeRequests.map((r) => r.type)).toEqual(['image/webp', 'image/png']);
  });

  it('falls back to PNG when the WebP encode returns nothing', async () => {
    decodesTo(4000, 3000);
    encoders = { 'image/png': new Blob(['png'], { type: 'image/png' }) };

    const prepared = await prepareImageForUpload(imageFile());

    expect(prepared.contentType).toBe('image/png');
  });
});

describe('uploadContentImage — the path the storage policy checks', () => {
  it('writes under the caller’s own uid prefix, which is what the bucket policy compares to auth.uid()', async () => {
    decodesTo(400, 300);

    const url = await uploadContentImage(imageFile({ size: 20 * 1024 }));

    expect(supabaseMocks.from).toHaveBeenCalledWith(CONTENT_IMAGE_BUCKET);
    const [path] = supabaseMocks.upload.mock.calls[0];
    expect(path).toBe(`${USER_ID}/${UUID}.png`);
    expect(path.split('/')[0]).toBe(USER_ID);
    expect(url).toContain(`${CONTENT_IMAGE_BUCKET}/${USER_ID}/${UUID}.png`);
  });

  it('names the object after the stored encoding, not the picked file', async () => {
    decodesTo(4000, 2000);

    await uploadContentImage(
      imageFile({ type: 'image/jpeg', name: 'holiday snap.jpg', size: 3 * 1024 * 1024 }),
    );

    const [path, blob, options] = supabaseMocks.upload.mock.calls[0];
    // A JPEG in, a WebP out — and the author's filename in neither.
    expect(path).toBe(`${USER_ID}/${UUID}.webp`);
    expect(path).not.toContain('holiday');
    expect((blob as Blob).type).toBe('image/webp');
    expect(options).toMatchObject({ contentType: 'image/webp' });
  });

  it('never overwrites an existing object, and caches the immutable one hard', async () => {
    decodesTo(400, 300);

    await uploadContentImage(imageFile({ size: 20 * 1024 }));

    expect(supabaseMocks.upload.mock.calls[0][2]).toMatchObject({
      upsert: false,
      cacheControl: '31536000',
    });
  });

  it('refuses an unauthenticated caller before it uploads anything', async () => {
    supabaseMocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(uploadContentImage(imageFile())).rejects.toThrow(/Sign in again/);
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
  });

  it('treats a failed session read the same way', async () => {
    supabaseMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'network' },
    });

    await expect(uploadContentImage(imageFile())).rejects.toThrow(/Sign in again/);
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
  });

  it('surfaces a rejected upload so the editor can leave the document alone', async () => {
    decodesTo(400, 300);
    supabaseMocks.upload.mockResolvedValue({ error: new Error('new row violates row-level security policy') });

    await expect(uploadContentImage(imageFile({ size: 20 * 1024 }))).rejects.toThrow(
      /row-level security/,
    );
    expect(supabaseMocks.getPublicUrl).not.toHaveBeenCalled();
  });

  it('does not reach storage when the file is one the bucket would refuse anyway', async () => {
    await expect(uploadContentImage(imageFile({ type: 'image/svg+xml' }))).rejects.toThrow(
      /PNG, JPEG, WebP and GIF/,
    );
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
  });
});
