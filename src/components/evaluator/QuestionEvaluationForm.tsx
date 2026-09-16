/**
 * QuestionEvaluationForm (#668, layout refresh #679) — the per-question
 * rubric form rendered inside an evaluator session. Persists exactly one
 * row per (evaluator, question) by upserting `question_evaluations`;
 * re-opening a previously evaluated question pre-fills from `existing`.
 *
 * All visible labels are Greek (per #668 acceptance criteria); the codes
 * stored to the DB live in `./rubric.ts` along with the labels.
 *
 * #679 groups the ~20 fields into labelled `<fieldset>` sections, swaps
 * 1-5 sliders for a segmented rating scale with anchors, renders problem
 * categories as toggle chips, and surfaces inline per-field validation
 * instead of a single all-or-nothing toast.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";
import { QuestionExpandedPanel } from "@/components/question-bank/expanded";
import type { UnifiedQuestion } from "@/lib/unified-question";
import type { Database } from "@/integrations/supabase/database-additions";
import {
  COGNITIVE_LEVEL_OPTIONS,
  CORE_RATING_QUESTIONS,
  DIFFICULTY_OPTIONS,
  PROBLEM_CATEGORIES,
  SAMPLED_RATING_QUESTIONS,
  VERDICT_OPTIONS,
  YES_NO_QUESTIONS,
  type CognitiveLevelCode,
  type DifficultyCode,
  type ProblemCategoryCode,
  type RatingQuestionKey,
  type VerdictCode,
  type YesNoQuestionKey,
} from "./rubric";
import {
  clearDraft,
  type FormDraft,
  loadDraft,
  saveDraft,
} from "./draftStorage";

export type QuestionEvaluationRow =
  Database["public"]["Tables"]["question_evaluations"]["Row"];

type FormState = {
  verdict: VerdictCode | null;
  difficulty_confirmation: DifficultyCode | null;
  yesNo: Record<YesNoQuestionKey, boolean | null>;
  /**
   * Core ratings (clarity, pedagogical_value) always carry a number — they're
   * required to submit. Specialist ratings start `null` and are only filled
   * (and required) when the sampled block is shown — see rubric.ts (#678).
   */
  ratings: Record<RatingQuestionKey, number | null>;
  problem_categories: Set<ProblemCategoryCode>;
  comment: string;
  cognitive_level: CognitiveLevelCode | null;
};

interface QuestionEvaluationFormProps {
  question: UnifiedQuestion;
  sessionId: string;
  evaluatorId: string;
  /**
   * When `true`, the cognitive-level block is rendered. The decision is owned
   * by the parent so it can be stable across re-mounts within a session
   * (per #668: "Sampling decision is stable for the duration of the session
   * for a given question").
   */
  showSampling: boolean;
  /** Existing evaluation by this evaluator for this question, if any. */
  existing: QuestionEvaluationRow | null;
  /**
   * Called as soon as a save is *issued* — the form has already updated
   * localStorage and the parent should optimistically treat the row as
   * saved so the UI doesn't sit waiting on the server (#682). Receives the
   * predicted shape (full payload + any preserved id/timestamps from
   * `existing`). The actual server row arrives later via `onSaveConfirmed`
   * if the optimistic prediction differs (id, updated_at, …).
   */
  onSaved: (next: QuestionEvaluationRow) => void;
  /**
   * Server confirmed the upsert. Called with the authoritative row so the
   * parent can reconcile any fields the optimistic prediction got wrong
   * (server-generated id on first save, updated_at). Optional — most
   * callers can skip this and treat `onSaved` as the only signal.
   */
  onSaveConfirmed?: (row: QuestionEvaluationRow) => void;
  /**
   * Server rejected the upsert. The parent should roll back to whatever
   * state it had before the optimistic `onSaved` call — passed back here
   * so the parent doesn't need to keep its own snapshot. `null` means
   * "no prior row existed", i.e. the question should drop out of
   * savedThisSession entirely.
   */
  onSaveFailed?: (previous: QuestionEvaluationRow | null) => void;
  /**
   * Mirrors the form's transient saving state to the parent so the #681
   * mobile sticky action bar can show its own spinner without lifting the
   * full form state into the page.
   */
  onSavingChange?: (saving: boolean) => void;
  /**
   * Fires whenever the form's draft becomes dirty (input that diverges
   * from the last-saved row) or clean (matches saved / freshly cleared
   * after a successful save). The session page uses this to render the
   * unsaved-changes dot in the question list and to register a
   * `beforeunload` warning when ANY question still has a dirty draft.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Imperative handle exposed to the parent (#680) so the session-level
 * keyboard handler can drive Submit (⌘/Ctrl+Enter) and the 1/2/3 quick
 * verdict shortcuts without lifting the form's internal state into the page.
 */
export interface QuestionEvaluationFormHandle {
  submit: () => void;
  setVerdict: (code: VerdictCode) => void;
}

function blankState(): FormState {
  return {
    verdict: null,
    difficulty_confirmation: null,
    yesNo: {
      question_good: null,
      answer_good: null,
    },
    ratings: {
      clarity: 3,
      pedagogical_value: 3,
      distractor_quality: null,
      curriculum_alignment: null,
      question_bank_alignment: null,
      language_appropriateness: null,
    },
    problem_categories: new Set(),
    comment: "",
    cognitive_level: null,
  };
}

function stateFromExisting(row: QuestionEvaluationRow): FormState {
  return {
    verdict: row.verdict as VerdictCode,
    difficulty_confirmation: row.difficulty_confirmation as DifficultyCode,
    yesNo: {
      question_good: row.question_good,
      answer_good: row.answer_good,
    },
    ratings: {
      clarity: row.clarity,
      pedagogical_value: row.pedagogical_value,
      distractor_quality: row.distractor_quality,
      curriculum_alignment: row.curriculum_alignment,
      question_bank_alignment: row.question_bank_alignment,
      language_appropriateness: row.language_appropriateness,
    },
    problem_categories: new Set((row.problem_categories ?? []) as ProblemCategoryCode[]),
    comment: row.comment ?? "",
    cognitive_level: (row.cognitive_level as CognitiveLevelCode | null) ?? null,
  };
}

function stateFromDraft(draft: FormDraft): FormState {
  return {
    verdict: draft.verdict,
    difficulty_confirmation: draft.difficulty_confirmation,
    yesNo: { ...draft.yesNo },
    ratings: { ...draft.ratings },
    problem_categories: new Set(draft.problem_categories),
    comment: draft.comment,
    cognitive_level: draft.cognitive_level,
  };
}

function draftFromState(state: FormState): FormDraft {
  return {
    verdict: state.verdict,
    difficulty_confirmation: state.difficulty_confirmation,
    yesNo: { ...state.yesNo },
    ratings: { ...state.ratings },
    problem_categories: Array.from(state.problem_categories),
    comment: state.comment,
    cognitive_level: state.cognitive_level,
  };
}

/**
 * Two form states are equivalent when every visible field matches. We
 * compare the JSON projection (after Set→array) so a freshly-mounted form
 * pre-filled from `existing` reads as clean even though the Set identity
 * differs from the saved row. Keys are sorted before serializing so that
 * drafts persisted under a different key-insertion order (e.g. after a field
 * was added/reordered) still compare correctly.
 */
function statesEqual(a: FormState, b: FormState): boolean {
  const sortKeys = (_: string, val: unknown) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort())
      : val;
  return (
    JSON.stringify(draftFromState(a), sortKeys) ===
    JSON.stringify(draftFromState(b), sortKeys)
  );
}

export const QuestionEvaluationForm = forwardRef<
  QuestionEvaluationFormHandle,
  QuestionEvaluationFormProps
>(function QuestionEvaluationForm(
  {
    question,
    sessionId,
    evaluatorId,
    showSampling,
    existing,
    onSaved,
    onSaveConfirmed,
    onSaveFailed,
    onSavingChange,
    onDirtyChange,
  },
  ref,
) {
  // The "baseline" is whatever was last committed — drives the dirty check
  // and is what we roll back to if an optimistic save fails. Tracked as
  // local state (not a useMemo of `existing`) so a successful optimistic
  // save can snap baseline to the just-saved state immediately, without
  // waiting for the parent to re-render with the predicted row. The
  // effect below keeps this in sync when `existing` updates externally
  // (parent fetch resolves, or a sibling component edits the same row).
  const externalBaseline = useMemo(
    () => (existing ? stateFromExisting(existing) : blankState()),
    [existing],
  );
  const [baseline, setBaseline] = useState<FormState>(externalBaseline);
  // Initial render preference (#682): a saved local draft > the
  // server-side baseline > a blank slate. Computed once via lazy init so
  // a late `existing` fetch doesn't clobber the user's in-progress edits;
  // the `externalBaseline` reconciliation is handled by the effect below.
  const [state, setState] = useState<FormState>(() => {
    const draft = loadDraft(evaluatorId, question.id);
    if (draft) return stateFromDraft(draft);
    return externalBaseline;
  });
  const [saving, setSaving] = useState(false);
  // First press of Submit while incomplete switches inline errors on; they
  // stay on for the rest of the session for this question, but each one
  // clears as soon as the field is filled.
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // When `existing` arrives late (or updates externally), sync the
  // baseline so the dirty check uses the freshest committed state. If
  // there's no local draft, also snap the form itself; with a draft
  // present, the user's in-progress edits win.
  useEffect(() => {
    setBaseline(externalBaseline);
    if (loadDraft(evaluatorId, question.id)) return;
    setState(externalBaseline);
    setSubmitAttempted(false);
  }, [externalBaseline, question.id, evaluatorId]);

  useEffect(() => {
    onSavingChange?.(saving);
    return () => onSavingChange?.(false);
  }, [saving, onSavingChange]);

  const isDirty = !statesEqual(state, baseline);

  // Debounced draft autosave (#682). Skip writes while the form is clean —
  // a clean form means the local draft should be cleared, not refreshed.
  useEffect(() => {
    if (!isDirty) {
      clearDraft(evaluatorId, question.id);
      return;
    }
    const handle = window.setTimeout(() => {
      saveDraft(evaluatorId, question.id, draftFromState(state));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [state, isDirty, evaluatorId, question.id]);

  // Notify the parent on dirty transitions only — passing `isDirty` every
  // render would still be cheap but the parent uses this to mutate a Set,
  // and React's state setter is referentially-equal-safe so the parent
  // re-renders nothing on a no-op.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const conditionalShown =
    state.verdict === "needs_fixing" || state.verdict === "reject";

  // Required-to-submit rule (#690): verdict + difficulty + the 2 yes/no
  // correctness checks + the 2 core ratings, always. Inside the sampled block
  // (~20% of questions), also cognitive_level + the 4 specialist ratings.
  // Specialist ratings render with a 3 default while the block is shown, so
  // the gate is implicit; we only check fields that can stay unset.
  const missing = {
    verdict: state.verdict === null,
    difficulty: state.difficulty_confirmation === null,
    question_good: state.yesNo.question_good === null,
    answer_good: state.yesNo.answer_good === null,
    cognitive_level: showSampling && state.cognitive_level === null,
  };
  const missingCount = Object.values(missing).filter(Boolean).length;
  const isComplete = missingCount === 0;
  const showErrors = submitAttempted;

  const handleSubmit = async () => {
    if (saving) return;
    if (!isComplete) {
      setSubmitAttempted(true);
      toast.error(`Συμπληρώστε τα πεδία που λείπουν (${missingCount})`);
      return;
    }
    setSaving(true);
    // Specialist ratings are NULL when not sampled — they aren't asked on
    // ~80% of questions per the tiered rubric (#678). The four columns
    // were made nullable in migration 20260626000000.
    const payload: Database["public"]["Tables"]["question_evaluations"]["Insert"] = {
      session_id: sessionId,
      question_id: question.id,
      evaluator_id: evaluatorId,
      verdict: state.verdict as VerdictCode,
      difficulty_confirmation: state.difficulty_confirmation as DifficultyCode,
      question_good: state.yesNo.question_good as boolean,
      answer_good: state.yesNo.answer_good as boolean,
      clarity: state.ratings.clarity ?? 3,
      pedagogical_value: state.ratings.pedagogical_value ?? 3,
      distractor_quality: showSampling
        ? (state.ratings.distractor_quality ?? 3)
        : null,
      curriculum_alignment: showSampling
        ? (state.ratings.curriculum_alignment ?? 3)
        : null,
      question_bank_alignment: showSampling
        ? (state.ratings.question_bank_alignment ?? 3)
        : null,
      language_appropriateness: showSampling
        ? (state.ratings.language_appropriateness ?? 3)
        : null,
      problem_categories: conditionalShown
        ? Array.from(state.problem_categories)
        : [],
      comment: conditionalShown && state.comment.trim() ? state.comment.trim() : null,
      was_sampled: showSampling,
      cognitive_level: showSampling ? state.cognitive_level : null,
    };

    // Build the optimistic row before issuing the network call — the
    // parent immediately treats this question as saved so the UI doesn't
    // sit waiting on the server (#682). Server-generated columns (id,
    // updated_at) inherit from `existing` when present; on first save we
    // forge a stand-in id so the parent's `Record<questionId, row>`
    // doesn't break on a null primary key. The server reconciliation
    // through `onSaveConfirmed` overwrites these with authoritative values.
    const now = new Date().toISOString();
    const optimisticRow: QuestionEvaluationRow = {
      ...payload,
      id: existing?.id ?? `optimistic-${question.id}`,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    } as QuestionEvaluationRow;
    const priorRow = existing;
    const priorBaseline = baseline;
    const snapshot = state;
    onSaved(optimisticRow);
    // Snap baseline to the just-saved state so the form is no longer
    // dirty from its own perspective — we don't rely on the parent
    // re-rendering us with the optimistic row. Clear the local draft for
    // the same reason. If the save fails below we restore both.
    setBaseline(snapshot);
    const draftSnapshot = draftFromState(snapshot);
    clearDraft(evaluatorId, question.id);

    try {
      const { data, error } = await supabase
        .from("question_evaluations")
        .upsert(payload, { onConflict: "evaluator_id,question_id" })
        .select()
        .single();

      if (error) throw error;
      toast.success("Η αξιολόγηση αποθηκεύτηκε");
      onSaveConfirmed?.(data as QuestionEvaluationRow);
    } catch (err) {
      console.error("Failed to save evaluation", err);
      toast.error("Αποτυχία αποθήκευσης");
      // Rollback: restore the draft + baseline so the user's input survives
      // and the form is dirty again, and ask the parent to roll back the
      // optimistic row. `priorRow` is null on a first save (the question
      // drops out of savedThisSession entirely).
      setBaseline(priorBaseline);
      saveDraft(evaluatorId, question.id, draftSnapshot);
      onSaveFailed?.(priorRow ?? null);
    } finally {
      setSaving(false);
    }
  };

  // Keep refs to the latest handlers so the imperative handle (#680) stays
  // stable across renders — useImperativeHandle re-runs only on dep change,
  // and re-creating the handle every render would defeat that.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  useImperativeHandle(
    ref,
    () => ({
      submit: () => {
        void handleSubmitRef.current();
      },
      setVerdict: (code: VerdictCode) => {
        setState((s) => ({ ...s, verdict: code }));
      },
    }),
    [],
  );

  return (
    <div className="space-y-6" data-testid="question-evaluation-form">
      <Card>
        <CardContent className="pt-6">
          <QuestionExpandedPanel
            question={question}
            onClose={() => {
              /* no-op — the form owns its own layout, no inline close */
            }}
            isAdmin={false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-8">
          <Section
            title="Συνολική κρίση & δυσκολία"
            testId="section-verdict-difficulty"
          >
            <FieldGroup
              label="Συνολική κρίση"
              required
              error={showErrors && missing.verdict ? "Επιλέξτε κρίση" : null}
            >
              {({ describedBy, invalid, labelId }) => (
                <RadioGroup
                  value={state.verdict ?? ""}
                  onValueChange={(v) =>
                    setState((s) => ({ ...s, verdict: v as VerdictCode }))
                  }
                  data-testid="verdict-group"
                  aria-labelledby={labelId}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  className="flex flex-wrap gap-x-6 gap-y-2"
                >
                  {VERDICT_OPTIONS.map((opt) => (
                    <RadioRow
                      key={opt.code}
                      id={`verdict-${opt.code}`}
                      value={opt.code}
                      label={opt.label}
                    />
                  ))}
                </RadioGroup>
              )}
            </FieldGroup>

            <FieldGroup
              label="Δυσκολία"
              required
              error={showErrors && missing.difficulty ? "Επιλέξτε δυσκολία" : null}
            >
              {({ describedBy, invalid, labelId }) => (
                <RadioGroup
                  value={state.difficulty_confirmation ?? ""}
                  onValueChange={(v) =>
                    setState((s) => ({
                      ...s,
                      difficulty_confirmation: v as DifficultyCode,
                    }))
                  }
                  data-testid="difficulty-group"
                  aria-labelledby={labelId}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  className="flex flex-wrap gap-x-6 gap-y-2"
                >
                  {DIFFICULTY_OPTIONS.map((opt) => (
                    <RadioRow
                      key={opt.code}
                      id={`difficulty-${opt.code}`}
                      value={opt.code}
                      label={opt.label}
                    />
                  ))}
                </RadioGroup>
              )}
            </FieldGroup>
          </Section>

          <Section title="Έλεγχοι ορθότητας" testId="section-correctness">
            {YES_NO_QUESTIONS.map((q) => (
              <FieldGroup
                key={q.key}
                label={q.label}
                required
                error={
                  showErrors && missing[q.key]
                    ? "Επιλέξτε Ναι ή Όχι"
                    : null
                }
              >
                {({ describedBy, invalid, labelId }) => (
                  <RadioGroup
                    value={
                      state.yesNo[q.key] === null
                        ? ""
                        : state.yesNo[q.key]
                          ? "yes"
                          : "no"
                    }
                    onValueChange={(v) =>
                      setState((s) => ({
                        ...s,
                        yesNo: { ...s.yesNo, [q.key]: v === "yes" },
                      }))
                    }
                    data-testid={`yesno-${q.key}`}
                    aria-labelledby={labelId}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    className="flex gap-6"
                  >
                    <RadioRow id={`${q.key}-yes`} value="yes" label="Ναι" />
                    <RadioRow id={`${q.key}-no`} value="no" label="Όχι" />
                  </RadioGroup>
                )}
              </FieldGroup>
            ))}
          </Section>

          <Section title="Αξιολόγηση ποιότητας" testId="section-quality">
            {CORE_RATING_QUESTIONS.map((r) => (
              <RatingScale
                key={r.key}
                rKey={r.key}
                label={r.label}
                value={state.ratings[r.key] ?? 3}
                onChange={(next) =>
                  setState((s) => ({
                    ...s,
                    ratings: { ...s.ratings, [r.key]: next },
                  }))
                }
              />
            ))}
            {showSampling &&
              SAMPLED_RATING_QUESTIONS.map((r) => (
                <RatingScale
                  key={r.key}
                  rKey={r.key}
                  label={r.label}
                  value={state.ratings[r.key] ?? 3}
                  onChange={(next) =>
                    setState((s) => ({
                      ...s,
                      ratings: { ...s.ratings, [r.key]: next },
                    }))
                  }
                />
              ))}
          </Section>

          {conditionalShown && (
            <Section
              title="Εντοπισμένα προβλήματα"
              testId="problem-block"
            >
              <FieldGroup label="Τι πρόβλημα εντοπίσατε;">
                {({ labelId }) => (
                  <ToggleGroup
                    type="multiple"
                    value={Array.from(state.problem_categories)}
                    onValueChange={(vals) =>
                      setState((s) => ({
                        ...s,
                        problem_categories: new Set(vals as ProblemCategoryCode[]),
                      }))
                    }
                    aria-labelledby={labelId}
                    data-testid="problem-categories"
                    className="flex flex-wrap justify-start gap-2"
                  >
                    {PROBLEM_CATEGORIES.map((cat) => (
                      <ToggleGroupItem
                        key={cat.code}
                        value={cat.code}
                        variant="outline"
                        size="default"
                        aria-label={cat.label}
                        data-testid={`problem-chip-${cat.code}`}
                        className="rounded-full px-4"
                      >
                        {cat.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                )}
              </FieldGroup>
              <FieldGroup label="Σχόλιο / προτεινόμενη διόρθωση">
                {({ labelId }) => (
                  <Textarea
                    value={state.comment}
                    onChange={(e) => setState((s) => ({ ...s, comment: e.target.value }))}
                    rows={3}
                    aria-labelledby={labelId}
                    data-testid="comment-input"
                  />
                )}
              </FieldGroup>
            </Section>
          )}

          {showSampling && (
            <Section
              title="Δειγματοληπτικός έλεγχος"
              testId="sampling-block"
            >
              <FieldGroup
                label="Γνωστικό επίπεδο"
                required
                error={
                  showErrors && missing.cognitive_level
                    ? "Επιλέξτε γνωστικό επίπεδο"
                    : null
                }
              >
                {({ describedBy, invalid, labelId }) => (
                  <RadioGroup
                    value={state.cognitive_level ?? ""}
                    onValueChange={(v) =>
                      setState((s) => ({ ...s, cognitive_level: v as CognitiveLevelCode }))
                    }
                    data-testid="cognitive-level-group"
                    aria-labelledby={labelId}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    className="flex flex-wrap gap-x-6 gap-y-2"
                  >
                    {COGNITIVE_LEVEL_OPTIONS.map((opt) => (
                      <RadioRow
                        key={opt.code}
                        id={`cog-${opt.code}`}
                        value={opt.code}
                        label={opt.label}
                      />
                    ))}
                  </RadioGroup>
                )}
              </FieldGroup>
            </Section>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <div className="flex items-center gap-3 text-xs text-muted-foreground min-w-0">
              <span
                data-testid="missing-summary"
                role={showErrors && missingCount > 0 ? "status" : undefined}
                aria-live="polite"
              >
                {showErrors && missingCount > 0
                  ? missingCount === 1
                    ? `1 πεδίο λείπει`
                    : `${missingCount} πεδία λείπουν`
                  : ""}
              </span>
              {isDirty && !saving ? (
                <span
                  data-testid="unsaved-indicator"
                  className="text-amber-700 dark:text-amber-400"
                  role="status"
                  aria-live="polite"
                >
                  Μη αποθηκευμένες αλλαγές
                </span>
              ) : null}
            </div>
            <Button
              onClick={handleSubmit}
              disabled={saving}
              data-testid="submit-evaluation"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Αποθήκευση…
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  {existing ? "Ενημέρωση" : "Αποθήκευση"}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
});

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  const legendId = useId();
  return (
    <fieldset
      data-testid={testId}
      className="space-y-5 border-t pt-6 first:border-t-0 first:pt-0"
      aria-labelledby={legendId}
    >
      <legend
        id={legendId}
        className="text-sm font-semibold text-foreground mb-1"
      >
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

interface FieldRenderArgs {
  labelId: string;
  describedBy: string | undefined;
  invalid: boolean;
}

function FieldGroup({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  children: (args: FieldRenderArgs) => React.ReactNode;
}) {
  const labelId = useId();
  const errorId = useId();
  const invalid = Boolean(error);
  return (
    <div className="space-y-2">
      <Label id={labelId} className="text-sm font-medium">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-muted-foreground ml-1">
            *
          </span>
        ) : null}
      </Label>
      {children({
        labelId,
        describedBy: invalid ? errorId : undefined,
        invalid,
      })}
      {invalid ? (
        <p
          id={errorId}
          role="alert"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

const RATING_ANCHOR_LOW = "κακό";
const RATING_ANCHOR_HIGH = "άριστο";

function RatingScale({
  rKey,
  label,
  value,
  onChange,
}: {
  rKey: RatingQuestionKey;
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <Label id={labelId} className="text-sm font-medium">
        {label}
      </Label>
      <span id={`${labelId}-hint`} className="sr-only">
        1 {RATING_ANCHOR_LOW} – 5 {RATING_ANCHOR_HIGH}
      </span>
      <ToggleGroup
        type="single"
        value={String(value)}
        onValueChange={(v) => {
          // Radix returns "" when the user toggles the active item off; we
          // want the rating to stay set since it's a 1-5 scale (no "unrated").
          if (!v) return;
          onChange(Number(v));
        }}
        aria-labelledby={labelId}
        aria-describedby={`${labelId}-hint`}
        data-testid={`rating-${rKey}`}
        className="flex w-full sm:max-w-md justify-start gap-1.5"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <ToggleGroupItem
            key={n}
            value={String(n)}
            variant="outline"
            size="default"
            aria-label={`${n}`}
            data-testid={`rating-${rKey}-option-${n}`}
            className={cn(
              "h-11 sm:h-10 w-11 sm:w-10 flex-1 sm:min-w-[2.5rem] tabular-nums",
            )}
          >
            {n}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex justify-between text-xs text-muted-foreground sm:max-w-md">
        <span>1 · {RATING_ANCHOR_LOW}</span>
        <span data-testid={`rating-${rKey}-value`}>{value}</span>
        <span>5 · {RATING_ANCHOR_HIGH}</span>
      </div>
    </div>
  );
}

function RadioRow({ id, value, label }: { id: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={value} />
      <Label htmlFor={id} className="cursor-pointer">
        {label}
      </Label>
    </div>
  );
}
