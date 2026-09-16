import { describe, it, expect, vi } from 'vitest';

// The real client throws at module load without VITE_SUPABASE_* — which CI
// does not set for unit tests. Nothing here reaches the network; the import
// exists only because editor-images.ts uploads through it.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getUser: vi.fn() }, storage: { from: vi.fn() } },
}));

import { fitWithin, MAX_IMAGE_HEIGHT, MAX_IMAGE_WIDTH } from '@/lib/editor-images';
import { renderAuthoredHtml } from '@/lib/latex-utils';

describe('fitWithin', () => {
  it('leaves an image that already fits alone', () => {
    expect(fitWithin(400, 300, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it('never enlarges a small image', () => {
    expect(fitWithin(20, 10, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT)).toEqual({ width: 20, height: 10 });
  });

  it('scales a wide image down by its width, keeping the aspect ratio', () => {
    // 4000x2000 is 2:1; bounded by width first.
    expect(fitWithin(4000, 2000, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT)).toEqual({
      width: 1200,
      height: 600,
    });
  });

  it('scales a tall image down by its height, keeping the aspect ratio', () => {
    // 2000x4000 is 1:2; the height bound bites well before the width one.
    expect(fitWithin(2000, 4000, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT)).toEqual({
      width: 450,
      height: 900,
    });
  });

  it('fits a photo inside BOTH bounds, not just the one it was picked for', () => {
    const fitted = fitWithin(4032, 3024, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT);
    expect(fitted.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
    expect(fitted.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    // 4:3 survives the scale.
    expect(fitted.width / fitted.height).toBeCloseTo(4032 / 3024, 2);
  });

  it('never rounds a sliver down to a zero-sized canvas', () => {
    const fitted = fitWithin(10000, 1, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT);
    expect(fitted.height).toBeGreaterThanOrEqual(1);
  });
});

describe('authored HTML with images', () => {
  it('keeps an uploaded image through the sanitizer students render behind', () => {
    const html = renderAuthoredHtml(
      '<p>Before</p><img src="https://example.supabase.co/storage/v1/object/public/content-images/u/a.webp" alt="A diagram"><p>After</p>',
    );
    expect(html).toContain('content-images/u/a.webp');
    expect(html).toContain('alt="A diagram"');
  });

  it('still strips script out of content that also carries an image', () => {
    const html = renderAuthoredHtml('<img src="https://example.com/a.png"><script>alert(1)</script>');
    expect(html).toContain('a.png');
    expect(html).not.toContain('<script');
  });

  it('drops an onerror handler smuggled onto an image', () => {
    const html = renderAuthoredHtml('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });
});
