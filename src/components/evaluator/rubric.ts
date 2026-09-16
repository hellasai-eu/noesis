/**
 * Evaluator rubric (#668) — single source of truth for Greek display labels
 * paired to stable English codes stored in `question_evaluations` /
 * `question_evaluation_sessions`. Greek strings here match issue #668's
 * acceptance criteria verbatim; the DB CHECK constraints in migration
 * 20260625000000_question_evaluation_schema.sql constrain the code sets.
 */

export type VerdictCode = "good" | "needs_fixing" | "reject";
export type DifficultyCode = "correct" | "easier" | "harder";
export type CognitiveLevelCode = "recall" | "understanding" | "application_analysis";
export type WouldUseCode = "yes_asis" | "yes_with_fixes" | "no";

export type YesNoQuestionKey = "question_good" | "answer_good";

export type RatingQuestionKey =
  | "clarity"
  | "distractor_quality"
  | "curriculum_alignment"
  | "question_bank_alignment"
  | "pedagogical_value"
  | "language_appropriateness";

export type ProblemCategoryCode =
  | "wrong_stated_answer"
  | "content_error"
  | "ambiguous_multiple_correct"
  | "weak_distractors"
  | "out_of_syllabus"
  | "wrong_difficulty"
  | "unclear_stem"
  | "grammatical_giveaway"
  | "low_value"
  | "inappropriate_language"
  | "bias"
  | "duplicate"
  | "other";

interface Option<T extends string> {
  code: T;
  label: string;
}

export const VERDICT_OPTIONS: ReadonlyArray<Option<VerdictCode>> = [
  { code: "good", label: "Καλή" },
  { code: "needs_fixing", label: "Χρειάζεται διόρθωση" },
  { code: "reject", label: "Απόρριψη" },
];

export const DIFFICULTY_OPTIONS: ReadonlyArray<Option<DifficultyCode>> = [
  { code: "correct", label: "Σωστή" },
  { code: "easier", label: "Ευκολότερη" },
  { code: "harder", label: "Δυσκολότερη" },
];

export const YES_NO_QUESTIONS: ReadonlyArray<{ key: YesNoQuestionKey; label: string }> = [
  { key: "question_good", label: "Η ερώτηση είναι ποιοτική και ορθά διατυπωμένη;" },
  { key: "answer_good", label: "Η δηλωμένη ορθή απάντηση είναι έγκυρη και επαρκής;" },
];

/**
 * Two tiers of ratings (#678):
 *  - CORE_RATING_QUESTIONS render on every question and are required to submit.
 *    They cover the two judgments every evaluator can make from the question
 *    text alone, in seconds: how clear it reads and how worthwhile it feels.
 *  - SAMPLED_RATING_QUESTIONS render only inside the sampled block (the same
 *    ~20% subset that asks for cognitive_level) and are required when shown.
 *    They cover specialist judgments that need MCQ-specific, curriculum, or
 *    stylistic context the evaluator may not have on every single question —
 *    so we only ask them on a sample where the evaluator is actively engaging
 *    with the deeper block. Lowers per-question fatigue from 6 sliders to 2.
 *
 * `RATING_QUESTIONS` is the union, kept for read-side consumers (the report
 * in #669 reads every column regardless of which tier produced it).
 */
export const CORE_RATING_QUESTIONS: ReadonlyArray<{ key: RatingQuestionKey; label: string }> = [
  { key: "clarity", label: "Σαφήνεια" },
  { key: "pedagogical_value", label: "Παιδαγωγική αξία" },
];

export const SAMPLED_RATING_QUESTIONS: ReadonlyArray<{ key: RatingQuestionKey; label: string }> = [
  { key: "distractor_quality", label: "Ποιότητα αντιπερισπασμών" },
  { key: "curriculum_alignment", label: "Ευθυγράμμιση με το Πρόγραμμα Σπουδών" },
  { key: "question_bank_alignment", label: "Ευθυγράμμιση με την Τράπεζα Θεμάτων" },
  { key: "language_appropriateness", label: "Καταλληλότητα γλώσσας" },
];

export const RATING_QUESTIONS: ReadonlyArray<{ key: RatingQuestionKey; label: string }> = [
  ...CORE_RATING_QUESTIONS,
  ...SAMPLED_RATING_QUESTIONS,
];

export const PROBLEM_CATEGORIES: ReadonlyArray<Option<ProblemCategoryCode>> = [
  { code: "wrong_stated_answer", label: "Λάθος δηλωμένη ορθή απάντηση" },
  { code: "content_error", label: "Λάθος περιεχομένου" },
  { code: "ambiguous_multiple_correct", label: "Ασαφής / πολλαπλές σωστές" },
  { code: "weak_distractors", label: "Αδύναμοι αντιπερισπασμοί" },
  { code: "out_of_syllabus", label: "Εκτός Π.Σ." },
  { code: "wrong_difficulty", label: "Λάθος δυσκολία" },
  { code: "unclear_stem", label: "Ασαφής εκφώνηση" },
  { code: "grammatical_giveaway", label: "Γραμματική προδίδει την απάντηση" },
  { code: "low_value", label: "Χαμηλή παιδαγωγική αξία" },
  { code: "inappropriate_language", label: "Ακατάλληλη γλώσσα" },
  { code: "bias", label: "Μεροληψία" },
  { code: "duplicate", label: "Διπλότυπο" },
  { code: "other", label: "Άλλο" },
];

export const COGNITIVE_LEVEL_OPTIONS: ReadonlyArray<Option<CognitiveLevelCode>> = [
  { code: "recall", label: "Ανάκληση" },
  { code: "understanding", label: "Κατανόηση" },
  { code: "application_analysis", label: "Εφαρμογή-Ανάλυση" },
];

export const WOULD_USE_OPTIONS: ReadonlyArray<Option<WouldUseCode>> = [
  { code: "yes_asis", label: "Ναι ως έχει" },
  { code: "yes_with_fixes", label: "Ναι με διορθώσεις" },
  { code: "no", label: "Όχι" },
];

/**
 * Per-session probability that any one question gets the cognitive-level
 * sampling block. Decided per question on first view (so unopened questions
 * don't burn samples), stable for the duration of the session.
 */
export const SAMPLING_PROBABILITY = 0.2;
