/**
 * A stable colour per course, for the student surface.
 *
 * The shelves are only scannable if a course keeps the same hue everywhere —
 * on its chip, on its due tile, on its practice tile — and keeps it between
 * sessions. So the colour is derived from the course id rather than stored:
 * no migration, no instructor decision to make, and no drift when the course
 * list is re-ordered or filtered.
 *
 * The six hues live in `index.css` as `--subject-N…` custom properties, with
 * light and dark values, so an inline `style` written from here resolves in
 * both themes. That is also why this returns CSS variable *references* rather
 * than hex: a Tailwind class cannot be composed at runtime from a course id,
 * and a literal hex would only be right in one theme.
 *
 * Colour is never the only signal. Every tile prints its course name; the hue
 * is an accelerator for students who have already learned it, not the label.
 */

export const SUBJECT_COLOR_COUNT = 6;

export interface SubjectColor {
  /** Saturated fill — hero tiles, chips, progress bars. */
  solid: string;
  /** Text on a light ground. Chosen for >= 4.5:1 contrast in both themes. */
  ink: string;
  /** Low-alpha wash for icon chips and tile backgrounds. */
  tint: string;
  /**
   * Fill for the one prominent tile in a shelf, with `heroInk` as its text.
   * A separate token from `solid` because no mid-tone of these hues carries
   * either white or near-black at 4.5:1 — the hero uses the deeper weight.
   */
  hero: string;
  heroInk: string;
  /** 1..6 — exposed for tests and for `data-` attributes. */
  index: number;
}

/**
 * FNV-1a over the course id. Any stable hash would do; this one is short,
 * dependency-free and spreads sequential UUIDs evenly enough that two courses
 * in the same class rarely collide.
 *
 * Pinned by a test: changing the hash re-colours every course in production,
 * which is exactly the kind of silent churn this module exists to prevent.
 */
function hashToIndex(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range without BigInt.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % SUBJECT_COLOR_COUNT) + 1;
}

/**
 * A hue by slot, for the things that are not a course: the shelf headings.
 * Each shelf keeps one hue across the whole surface so the row is recognisable
 * before its heading is read.
 */
export function subjectColorByIndex(index: number): SubjectColor {
  const slot = ((Math.trunc(index) - 1) % SUBJECT_COLOR_COUNT + SUBJECT_COLOR_COUNT)
    % SUBJECT_COLOR_COUNT
    + 1;
  return {
    index: slot,
    solid: `var(--subject-${slot})`,
    ink: `var(--subject-${slot}-ink)`,
    tint: `var(--subject-${slot}-tint)`,
    hero: `var(--subject-${slot}-hero)`,
    heroInk: "var(--subject-hero-fg)",
  };
}

export function subjectColor(courseId: string | null | undefined): SubjectColor {
  // A missing id would otherwise hash to a real hue and imply a course that
  // isn't there. Slot 6 is as good as any; the caller is rendering something
  // course-less (a mixed shelf, a skeleton).
  return subjectColorByIndex(courseId ? hashToIndex(courseId) : SUBJECT_COLOR_COUNT);
}
