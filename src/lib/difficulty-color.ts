/**
 * Single source of truth for the difficulty-badge palette across every
 * surface that renders a question's difficulty. Uses a clean traffic-light
 * palette (solid green / amber / red) so the badges visually pop off the
 * pastel question-type badges next to them.
 *
 * Migrated from per-file `getDifficultyColor` helpers (11 copies) — see
 * the corresponding PR for the historical context.
 */
export type Difficulty = "easy" | "medium" | "hard" | (string & {});

export function getDifficultyClass(difficulty: Difficulty): string {
  switch (difficulty) {
    case "easy":
      return "bg-green-600 text-white border-transparent hover:bg-green-600";
    case "medium":
      return "bg-amber-400 text-amber-950 border-transparent hover:bg-amber-400";
    case "hard":
      return "bg-red-600 text-white border-transparent hover:bg-red-600";
    default:
      return "bg-muted text-muted-foreground border-transparent";
  }
}
