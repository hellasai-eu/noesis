/**
 * Ambient types for the test environment.
 *
 * `vitest.setup.ts` imports `@testing-library/jest-dom/vitest`, whose whole job
 * is to augment vitest's `Assertion` interface with `toBeInTheDocument`,
 * `toHaveTextContent` and friends. But that setup file sits at the repo root
 * while `tsconfig.app.json` includes only `src`, so the compiler never saw the
 * augmentation — every jest-dom matcher in every test was an error, 1,442 of
 * them. Nobody noticed, because `tsc` was never actually run (see the note on
 * the type-check script in package.json).
 *
 * This file lives inside `src` purely so the compiler picks it up.
 */

/// <reference types="@testing-library/jest-dom/vitest" />
