import { describe, it, expect } from 'vitest';
// No DOMPurify mock — this file exercises the real sanitizer

import { sanitizeMathContent } from '@/lib/latex-utils';

describe('sanitizeMathContent (real DOMPurify)', () => {
  it('preserves <sup> tags', () => {
    const result = sanitizeMathContent('H<sup>+</sup>');
    expect(result).toContain('<sup>');
    expect(result).toContain('</sup>');
  });

  it('preserves <sub> tags', () => {
    const result = sanitizeMathContent('H<sub>2</sub>O');
    expect(result).toContain('<sub>');
    expect(result).toContain('</sub>');
  });

  it('strips disallowed tags', () => {
    const result = sanitizeMathContent('<script>alert(1)</script>safe');
    expect(result).not.toContain('<script>');
    expect(result).toContain('safe');
  });

  it('preserves MathML elements', () => {
    const result = sanitizeMathContent('<math><msup><mi>x</mi><mn>2</mn></msup></math>');
    expect(result).toContain('<math>');
    expect(result).toContain('<msup>');
  });
});
