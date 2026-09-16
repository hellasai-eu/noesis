/**
 * Shared study guide predicates (#1004).
 *
 * `pieceIsStale` lives here rather than in a component because three surfaces
 * need it — the guide list, the assignment check and the piece editor — and the
 * first two disagreed once already, which is how a stale warning went missing
 * at the only moment it mattered.
 */

/**
 * Whether a piece's questions predate the theory they are supposed to test.
 *
 * Questions are generated FROM the stored theory, so an edit invalidates them.
 * `theory_updated_at` is bumped by a database trigger only when `theory_html`
 * actually changes — renaming a piece does not raise a false alarm — and
 * `questions_generated_at` is stamped inside the same transaction that writes
 * the questions, so the two can never disagree with what was written.
 *
 * A piece with questions but no `questions_generated_at` predates the column
 * and is treated as stale: over-warning is the safe direction.
 */
export function pieceIsStale(
  questionsGeneratedAt: string | null,
  theoryUpdatedAt: string | null,
): boolean {
  if (!questionsGeneratedAt) return true;
  if (!theoryUpdatedAt) return false;
  return new Date(questionsGeneratedAt) < new Date(theoryUpdatedAt);
}

/**
 * Whether a guide may be handed out to a class.
 *
 * A guide with no pieces must not be assignable: the student opens it to
 * "This study guide has no pieces yet". Outline generation can fail after the
 * guide row is created, so a pieceless guide is a state the list really
 * reaches, not a hypothetical.
 *
 * This used to be carried implicitly by the Publish button's
 * `disabled={pieceCount === 0}`. When the publish step was removed the guard
 * nearly went with it — it lives here now so it is a property of the guide
 * rather than of one button.
 *
 * `hasExistingAssignments` is the escape hatch: a guide that went out and then
 * had every piece deleted must still expose its assignment UI, or the
 * instructor cannot take it back. It has to win over every other rule below
 * for the same reason — an already-assigned guide must always be retractable,
 * however incomplete it has since become.
 *
 * `incompletePieces` (pieces with no questions) now BLOCKS rather than warns.
 * This reverses the earlier call, which let it through on the grounds that a
 * piece might be deliberately question-free: in practice a student reaching a
 * piece with nothing to answer cannot advance past it, so "deliberately
 * question-free" is not a state the player supports.
 */
export function guideIsAssignable(
  pieceCount: number,
  hasExistingAssignments: boolean,
  incompletePieces = 0,
): boolean {
  if (hasExistingAssignments) return true;
  return pieceCount > 0 && incompletePieces === 0;
}

/**
 * Targets an incomplete guide may still be saved with.
 *
 * `guideIsAssignable` opens the dialog for an already-assigned guide whatever
 * its state, so the instructor can retract it — but "can open the dialog" is
 * not "can hand it to another class". Without this, the escape hatch is a way
 * to assign an incomplete guide to a NEW class simply because it was already
 * assigned to one.
 *
 * So while a guide is incomplete, a save may only keep or drop targets it
 * already had. Returns the additions, which the caller refuses; an empty array
 * means the save is a pure removal (or a no-op) and can proceed.
 */
/**
 * Whether a study-guide assignment row counts as DONE.
 *
 * Done is a derived state, never stored: an assignment is done once the
 * instructor marked it (`closed_at` set) OR its `due_date` has passed. Passing
 * the due date flips the state automatically with no cron involved — every
 * surface just re-derives it. Note the asymmetry with enforcement: only
 * `closed_at` blocks student submissions (see the 20260910120000 migration);
 * a passed due date alone lets a mid-guide student finish, the same grace
 * quizzes give started attempts.
 *
 * `now` is injectable for tests only.
 */
export function assignmentIsDone(
  closedAt: string | null,
  dueDate: string | null,
  now: number = Date.now(),
): boolean {
  if (closedAt) return true;
  return !!dueDate && new Date(dueDate).getTime() < now;
}

/**
 * Mirrors `MIN_GUIDE_THEORY_CHARS` in
 * `supabase/functions/_shared/study-guide-sources.ts` (and the refusal
 * threshold in `generate-study-guide-questions`): a piece whose stripped
 * theory is shorter than this counts as having no theory. Keep in sync.
 */
export const MIN_STUDY_GUIDE_THEORY_CHARS = 50;

/** Strips tags the same way the edge functions do before measuring theory. */
export function theoryHtmlAsText(html: string | null): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a guide may be used as a question-generation SOURCE:
 * generation is grounded in the stored theory and dedups against the guide's
 * own questions, so both must exist for every piece. This is the client-side
 * mirror of the check `generate-questions` enforces server-side — here it only
 * decides which guides the dialog offers.
 */
export function guideIsCompleteSource(
  pieces: Array<{ theoryHtml: string | null; hasQuestions: boolean }>,
): boolean {
  return (
    pieces.length > 0 &&
    pieces.every(
      (p) =>
        theoryHtmlAsText(p.theoryHtml).length >= MIN_STUDY_GUIDE_THEORY_CHARS &&
        p.hasQuestions,
    )
  );
}

export function disallowedNewTargets(
  incompletePieces: number,
  existing: Array<{ offering_id: string; group_id: string | null }>,
  next: Array<{ offering_id: string; group_id: string | null }>,
): Array<{ offering_id: string; group_id: string | null }> {
  if (incompletePieces === 0) return [];
  const key = (t: { offering_id: string; group_id: string | null }) =>
    `${t.offering_id}::${t.group_id ?? ""}`;
  const had = new Set(existing.map(key));
  return next.filter((t) => !had.has(key(t)));
}
