import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";
import { redactRosterNames } from "./redact-names.ts";

export interface StudentSnapshot {
  /**
   * PII boundary: `hint` is substituted into {{group_audience_hint}} and sent
   * to OpenAI. It must never contain a student's name (issue #557) — only
   * pseudonymous performance signals plus admin-note content that has been
   * redacted of every institution-roster name. `full_name` is returned separately
   * for instructor-UI labeling and must not be folded into `hint`.
   */
  hint: string;
  used_admin_notes: boolean;
  full_name: string | null;
  total_quiz_answers: number;
}

interface MasteryRow {
  competency_id: string;
  mastery_percentage: number | null;
  correct_mcq_answers: number | null;
  total_mcq_questions: number | null;
}

interface QuizAnswerRow {
  question_id: string;
  is_correct: boolean;
}

interface QuestionDifficultyRow {
  id: string;
  difficulty: string | null;
}

interface CompetencyRow {
  id: string;
  title: string;
}

/**
 * Every query here is best-effort: a failure degrades the hint rather than
 * failing generation. That makes silent failures invisible, so each one is
 * logged — a snapshot that quietly loses a signal looks like weak AI output
 * with no other trace.
 */
function warnQueryFailure(what: string, error: unknown): void {
  if (!error) return;
  const e = error as { message?: string; code?: string };
  logger.warn(`student-snapshot: ${what} query failed`, {
    error: e?.message ?? String(error),
    code: e?.code,
  });
}

/** Postgres "undefined_table" — expected where #519's notes table isn't deployed. */
const UNDEFINED_TABLE = "42P01";

/**
 * Build a per-student audience-hint string for AI question generation:
 * mastery snapshot + quiz accuracy + admin notes for personalised generation.
 *
 * PII regime: the student's name never enters the hint, and admin-note bodies
 * are included only after every profile name in the student's institution
 * (notes can mention classmates from other classes, or staff) is redacted —
 * the same guard cluster-students-by-performance applies to instructor free
 * text. Notes are omitted when the roster cannot be read in full, because
 * unredactable free text must not cross to OpenAI. This transfer is disclosed
 * in the ROPA (§6.2) and the subprocessor list — keep those in sync with what
 * this function sends.
 *
 * Tolerates the absence of #519's student_admin_notes table (returns the
 * hint without that section instead of failing).
 */
export async function buildStudentSnapshot(
  supabase: SupabaseClient,
  courseId: string,
  studentUserId: string,
): Promise<StudentSnapshot | null> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;

  // Profile — full_name is returned for instructor-UI labeling ONLY; it is
  // also fed to the redaction pass below so it can never survive into `hint`.
  // institution_id scopes both the redaction roster and the notes query.
  const { data: profile, error: profileErr } = await sb
    .from("profiles")
    .select("full_name, institution_id")
    .eq("user_id", studentUserId)
    .maybeSingle();
  warnQueryFailure("profile", profileErr);
  // Fail closed: the redaction backstop below needs the student's name tokens
  // to scrub instructor-authored titles. If the profile query errored, a name
  // may exist that we cannot redact against — skip the hint entirely rather
  // than risk it crossing to OpenAI. (A profile with a null full_name is
  // fine: there is no recorded name to leak.)
  if (profileErr) return null;
  const fullName = (profile?.full_name as string | null) ?? null;
  const institutionId = (profile?.institution_id as string | null) ?? null;

  // Mastery rows for this student in this course
  const { data: masteryRows, error: masteryErr } = await sb
    .from("student_competency_mastery")
    .select("competency_id, mastery_percentage, correct_mcq_answers, total_mcq_questions")
    .eq("user_id", studentUserId)
    .eq("course_id", courseId);
  warnQueryFailure("competency mastery", masteryErr);

  const mastery: MasteryRow[] = (masteryRows as MasteryRow[] | null) ?? [];

  // Quiz answers — overall % + per-difficulty
  const { data: qaRows, error: qaErr } = await sb
    .from("quiz_answers")
    .select("question_id, is_correct")
    .eq("user_id", studentUserId)
    .eq("course_id", courseId)
    .limit(5000);
  warnQueryFailure("quiz answers", qaErr);

  const quizAnswers: QuizAnswerRow[] = (qaRows as QuizAnswerRow[] | null) ?? [];
  let totalCorrect = 0;
  for (const r of quizAnswers) if (r.is_correct) totalCorrect++;

  const accuracyByDifficulty: Record<string, { correct: number; total: number }> = {};
  if (quizAnswers.length > 0) {
    const qIds = Array.from(new Set(quizAnswers.map((r) => r.question_id)));
    const { data: qRows, error: qErr } = await sb
      .from("questions")
      .select("id, difficulty")
      .in("id", qIds);
    warnQueryFailure("question difficulty", qErr);
    const difficultyById = new Map<string, string>(
      ((qRows as QuestionDifficultyRow[] | null) ?? []).map((q) => [q.id, q.difficulty ?? "unknown"]),
    );
    for (const r of quizAnswers) {
      const d = difficultyById.get(r.question_id) ?? "unknown";
      const cell = accuracyByDifficulty[d] ?? { correct: 0, total: 0 };
      cell.total++;
      if (r.is_correct) cell.correct++;
      accuracyByDifficulty[d] = cell;
    }
  }

  // Resolve competency titles for mastery rows
  const masteryCompIds = mastery.map((m) => m.competency_id).filter(Boolean);
  const titleByCompetencyId = new Map<string, string>();
  if (masteryCompIds.length > 0) {
    const { data: compRows, error: compErr } = await sb
      .from("course_competencies")
      .select("id, title")
      .in("id", masteryCompIds);
    warnQueryFailure("competency titles", compErr);
    for (const row of ((compRows as CompetencyRow[] | null) ?? [])) {
      titleByCompetencyId.set(row.id, row.title);
    }
  }

  // Sort mastery rows weakest-first for the hint
  const masteryRanked = mastery
    .map((m) => ({
      title: titleByCompetencyId.get(m.competency_id) ?? null,
      mastery: typeof m.mastery_percentage === "number" ? m.mastery_percentage : null,
      correct: m.correct_mcq_answers ?? 0,
      total: m.total_mcq_questions ?? 0,
    }))
    .filter((r) => r.title)
    .sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0));

  const weakest = masteryRanked.slice(0, 5);
  const weakestSet = new Set(weakest);
  const strongest = masteryRanked.slice(-3).reverse().filter((r) => !weakestSet.has(r));

  // Evaluation competency scores (most recent evaluation for this student in this course)
  let evalLowScores: { title: string; score: number }[] = [];
  try {
    const { data: evalRow, error: evalErr } = await sb
      .from("student_evaluations")
      .select("id")
      .eq("user_id", studentUserId)
      .eq("course_id", courseId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    warnQueryFailure("latest evaluation", evalErr);
    const evaluationId = (evalRow as { id?: string } | null)?.id;
    if (evaluationId) {
      const { data: scoreRows, error: scoreErr } = await sb
        .from("evaluation_competency_scores")
        .select("competency_id, score")
        .eq("evaluation_id", evaluationId);
      warnQueryFailure("evaluation competency scores", scoreErr);
      const scored = ((scoreRows as { competency_id: string; score: number | null }[] | null) ?? [])
        .filter((r) => typeof r.score === "number" && r.score! < 60)
        .map((r) => ({ competency_id: r.competency_id, score: r.score as number }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 5);
      if (scored.length > 0) {
        const missing = scored.map((s) => s.competency_id).filter((id) => !titleByCompetencyId.has(id));
        if (missing.length > 0) {
          const { data: more, error: moreErr } = await sb
            .from("course_competencies")
            .select("id, title")
            .in("id", missing);
          warnQueryFailure("evaluation competency titles", moreErr);
          for (const row of ((more as CompetencyRow[] | null) ?? [])) {
            titleByCompetencyId.set(row.id, row.title);
          }
        }
        evalLowScores = scored
          .map((s) => ({ title: titleByCompetencyId.get(s.competency_id) ?? "", score: s.score }))
          .filter((s) => s.title);
      }
    }
  } catch (err) {
    // Non-fatal: skip evaluation signal if anything goes wrong.
    logger.warn("student-snapshot: evaluation signal skipped", {
      error: (err as Error)?.message ?? String(err),
    });
  }

  // Redaction roster: every profile name in the student's institution.
  // Notes are institution-scoped and can mention anyone in it (a pupil from
  // another class, a teacher), so a course-scoped roster would leave those
  // names unredacted. Paginated because PostgREST caps a response at 1000
  // rows — silent truncation would silently break the "every name redacted"
  // guarantee, so hitting the page cap fails closed instead.
  const ROSTER_PAGE = 1000;
  const ROSTER_MAX_PAGES = 20;
  let rosterNames: Array<string | null> = [];
  let rosterOk = false;
  if (institutionId) {
    for (let page = 0; page < ROSTER_MAX_PAGES; page++) {
      const { data: rosterRows, error: rosterErr } = await sb
        .from("profiles")
        .select("full_name")
        .eq("institution_id", institutionId)
        .order("user_id", { ascending: true })
        .range(page * ROSTER_PAGE, (page + 1) * ROSTER_PAGE - 1);
      if (rosterErr) {
        warnQueryFailure("institution roster", rosterErr);
        rosterOk = false;
        break;
      }
      const rows = (rosterRows as { full_name: string | null }[] | null) ?? [];
      rosterNames = rosterNames.concat(rows.map((r) => r.full_name));
      if (rows.length < ROSTER_PAGE) {
        rosterOk = true;
        break;
      }
      if (page === ROSTER_MAX_PAGES - 1) {
        logger.warn("student-snapshot: institution roster exceeds page cap, omitting admin notes", {
          institutionId,
          fetched: rosterNames.length,
        });
      }
    }
  } else {
    logger.warn("student-snapshot: student has no institution, omitting admin notes", { studentUserId });
  }

  // Admin notes — the pedagogical context this hint exists for ("has
  // dyslexia, give concrete examples"). Scoped to the student's current
  // institution so every note matches the redaction roster's scope, and
  // included only when the roster read succeeded: notes routinely name the
  // student, classmates, or staff, and free text we cannot redact must not
  // cross to OpenAI. Graceful if the table doesn't exist yet (#519 not
  // merged).
  let usedAdminNotes = false;
  let adminNoteBodies: string[] = [];
  if (rosterOk && institutionId) {
    try {
      const { data: noteRows, error: notesErr } = await sb
        .from("student_admin_notes")
        .select("body, created_at")
        .eq("student_user_id", studentUserId)
        .eq("institution_id", institutionId)
        .order("created_at", { ascending: false })
        .limit(5);
      if (!notesErr && noteRows && Array.isArray(noteRows)) {
        adminNoteBodies = (noteRows as { body: string }[]).map((r) => r.body).filter(Boolean);
        usedAdminNotes = adminNoteBodies.length > 0;
      } else if ((notesErr as { code?: string } | null)?.code === UNDEFINED_TABLE) {
        // Expected wherever #519 isn't deployed — debug, not warn.
        logger.debug("student-snapshot: student_admin_notes table absent, skipping notes");
      } else {
        warnQueryFailure("admin notes", notesErr);
      }
    } catch (err) {
      logger.warn("student-snapshot: admin notes skipped", {
        error: (err as Error)?.message ?? String(err),
      });
    }
  } else {
    logger.warn("student-snapshot: roster unavailable, omitting admin notes from hint", {
      courseId,
      studentUserId,
    });
  }

  // Assemble the hint. No name: the hint crosses to OpenAI, and "this
  // individual" personalizes exactly as well as a name the model can't use.
  const lines: string[] = [];
  lines.push("Targeted student: tailor every question to this individual.");

  if (quizAnswers.length > 0) {
    const pct = Math.round((totalCorrect / quizAnswers.length) * 100);
    lines.push(`Recent MCQ accuracy: ${pct}% correct over ${quizAnswers.length} answers.`);
    const diffEntries = Object.entries(accuracyByDifficulty)
      .filter(([, v]) => v.total > 0)
      .map(([d, v]) => `${d}: ${Math.round((v.correct / v.total) * 100)}% (${v.correct}/${v.total})`);
    if (diffEntries.length > 0) {
      lines.push(`Accuracy by difficulty — ${diffEntries.join("; ")}.`);
    }
  } else {
    lines.push("No prior MCQ attempts on record for this student in this course.");
  }

  if (weakest.length > 0) {
    const w = weakest
      .map((r) => `${r.title} (mastery ${Math.round(r.mastery ?? 0)}%; ${r.correct}/${r.total} correct)`)
      .join("; ");
    lines.push(`Weakest competencies: ${w}.`);
  }
  if (strongest.length > 0) {
    const s = strongest.map((r) => `${r.title} (${Math.round(r.mastery ?? 0)}%)`).join("; ");
    lines.push(`Stronger competencies: ${s}.`);
  }

  if (evalLowScores.length > 0) {
    const e = evalLowScores.map((s) => `${s.title} (eval ${Math.round(s.score)})`).join("; ");
    lines.push(`Recent low evaluation scores: ${e}.`);
  }

  if (adminNoteBodies.length > 0) {
    lines.push("Teacher guidance on file (most recent first, names redacted, treat as confidential teaching context):");
    for (const body of adminNoteBodies) {
      lines.push(`- ${body.replace(/\s+/g, " ").slice(0, 600)}`);
    }
  }

  lines.push(
    "Target their weakest competencies, build on their strengths, and adjust difficulty to genuinely stretch this student while staying strictly grounded in the provided material.",
  );

  // Which signals actually made it into the hint. Pairs with the warnings
  // above to tell "student has no history" apart from "a query failed".
  logger.debug("student-snapshot built", {
    courseId,
    studentUserId,
    masteryCompetencies: masteryRanked.length,
    quizAnswers: quizAnswers.length,
    evalLowScores: evalLowScores.length,
    adminNotes: adminNoteBodies.length,
    rosterNames: rosterNames.length,
  });

  // Redaction pass over the whole assembled hint: admin notes and
  // instructor-authored competency/evaluation titles are free text that can
  // name the target student, classmates, or staff, so scrub every
  // institution-roster name — the same guard cluster-students-by-performance
  // applies to instructor special instructions.
  return {
    hint: redactRosterNames(lines.join("\n"), [fullName, ...rosterNames]),
    used_admin_notes: usedAdminNotes,
    full_name: fullName,
    total_quiz_answers: quizAnswers.length,
  };
}
