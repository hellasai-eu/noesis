/**
 * Student sequential study-guide player (#980).
 *
 * An assigned guide presents its pieces in strict order. Each piece shows its
 * theory then its questions; the student answers every question and submits the
 * whole piece at once. Grading is server-side (`submit-study-guide-piece`) and
 * answers are immutable — a completed piece reopens read-only for review. The
 * next piece unlocks only after the current one is submitted.
 *
 * The lock/unlock state machine and the "all answered" submit gate are pure
 * (`@/lib/study-guide-player`); this component is the wiring + rendering. The
 * per-type answer surfaces are the shared controlled fields
 * (`@/components/question-fields`), the same ones the formal quiz uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Lock, CheckCircle2, Loader2, Send, BookOpen, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useAuth } from "@/hooks/useAuth";
import type { Json } from "@/integrations/supabase/types";
import type { QuestionType } from "@/types/question";
import { renderAuthoredHtml, processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import {
  mcqOptionsFromPayload,
  mcqCorrectIndicesFromAnswerKey,
  fillGapsStemFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsSkeletonFromStem,
  orderingItemsFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationAssignmentsFromAnswerKey,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import {
  McqField,
  OpenField,
  FillGapsField,
  OrderingField,
  ClassificationField,
} from "@/components/question-fields";
import {
  computePieceStates,
  splitPieceIdsByReveal,
  isGuideComplete,
  emptyPlayerAnswer,
  isPlayerAnswerComplete,
  unansweredQuestionIds,
  pieceSubmitReady,
  playerSubmission,
  playerDraftEntry,
  readPlayerAnswer,
  readPlayerDraft,
  type PieceStatus,
  type PlayerAnswer,
  type PlayerQuestion,
} from "@/lib/study-guide-player";
import "katex/dist/katex.min.css";

interface Props {
  studyGuideId: string;
  offeringId: string;
  courseId: string;
  onBack: () => void;
}

interface LoadedQuestion extends PlayerQuestion {
  id: string;
  type: QuestionType;
  question: string;
  explanation: string;
  position: number;
  options: string[];
  correctIndices: number[];
  fillGapsStem: string;
  fillGapsGaps: { ordinal: number; acceptable: string[] }[];
  orderingItems: string[];
  categories: { id: string; label: string }[];
  items: { id: string; text: string }[];
  classificationAssignments: Record<string, string>;
  diagram: { source: string; alt?: string } | null;
}

interface LoadedPiece {
  id: string;
  position: number;
  title: string;
  theoryHtml: string | null;
  questions: LoadedQuestion[];
}

interface GradedAnswer {
  questionId: string;
  pieceId: string;
  submission: Json | null;
  isCorrect: boolean | null;
  grade: number | null;
  feedback: string | null;
  strengths: string[] | null;
  areasForImprovement: string[] | null;
}

type QuestionRow = {
  id: string;
  type: string;
  question: string | null;
  payload: Json | null;
  // Both absent for the current (unanswered) piece — see PIECE_QUESTION_COLUMNS.
  answer_key?: Json | null;
  explanation?: string | null;
};

/**
 * The embedded `questions` columns, with and without the answer-bearing ones.
 *
 * Two shapes rather than one because neither the key nor the explanation may
 * reach the browser for a piece the student has not yet submitted (#1011).
 * `explanation` is written to justify why the key is correct, so it gives the
 * answer away as readily as the key does — and the player renders it nowhere
 * before review, so withholding it costs nothing.
 *
 * `ordering` is the exception neither shape can cover: its canonical order
 * lives in `payload.items`, so the correct sequence travels with the data
 * needed to render the question at all (#1117).
 */
const PIECE_QUESTION_COLUMNS = {
  revealed:
    "piece_id, position, questions!inner(id, type, question, payload, answer_key, explanation)",
  unrevealed:
    "piece_id, position, questions!inner(id, type, question, payload)",
} as const;

function toLoadedQuestion(
  row: QuestionRow,
  position: number,
  revealed: boolean,
): LoadedQuestion {
  const diagram = questionDiagramFromPayload(row.payload);
  const answerKey = revealed ? row.answer_key ?? null : null;
  const stem = fillGapsStemFromPayload(row.payload);
  return {
    id: row.id,
    type: row.type as QuestionType,
    question: row.question ?? "",
    // Blanked rather than passed through, for the same reason `answerKey` is:
    // if the projection above ever regains the column, the answer-bearing text
    // still does not reach an unsubmitted question's state.
    explanation: revealed ? row.explanation ?? "" : "",
    position,
    options: mcqOptionsFromPayload(row.payload),
    correctIndices: mcqCorrectIndicesFromAnswerKey(answerKey),
    fillGapsStem: stem,
    // Before reveal the student still needs one input per blank, so the gap
    // skeleton is derived from the stem instead of the withheld key.
    fillGapsGaps: revealed
      ? fillGapsAcceptableAnswersFromAnswerKey(answerKey)
      : fillGapsSkeletonFromStem(stem),
    orderingItems: orderingItemsFromPayload(row.payload),
    categories: classificationCategoriesFromPayload(row.payload),
    items: classificationItemsFromPayload(row.payload),
    classificationAssignments: classificationAssignmentsFromAnswerKey(answerKey),
    diagram: diagram ? { source: diagram.source, alt: diagram.alt } : null,
  };
}

const DRAFT_SAVE_DELAY_MS = 800;

export function StudyGuidePlayer({ studyGuideId, offeringId, courseId, onBack }: Props) {
  const { t } = useTranslation("studyGuide");
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [pieces, setPieces] = useState<LoadedPiece[]>([]);
  const [currentPiecePosition, setCurrentPiecePosition] = useState(0);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  // Graded answers, keyed by question id (only for submitted pieces).
  const [answers, setAnswers] = useState<Record<string, GradedAnswer>>({});
  // The live draft for the current (unsubmitted) piece, keyed by question id.
  const [draft, setDraft] = useState<Record<string, PlayerAnswer>>({});
  const [openPieceId, setOpenPieceId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Fetches everything the player shows, and REPORTS whether it worked.
   *
   * The boolean matters because `submitPiece` refetches after the submission has
   * already committed server-side. If this swallowed a failure silently, that
   * caller would go on to say "the next piece is unlocked" while the component
   * still held pre-submit state — telling the student the opposite of what they
   * are looking at. `quiet` lets such a caller replace the generic message with
   * one that says what actually happened.
   */
  const load = useCallback(async (opts?: { quiet?: boolean }): Promise<boolean> => {
    if (!userId) return false;
    setLoading(true);
    try {
      const { data: guide, error: guideError } = await supabase
        .from("study_guides")
        .select("id, title")
        .eq("id", studyGuideId)
        .maybeSingle();
      if (guideError) throw guideError;
      if (!guide) {
        toast.error(t("toast.unavailable"));
        onBack();
        return false;
      }
      setTitle(guide.title);

      const { data: pieceRows, error: pieceError } = await supabase
        .from("study_guide_pieces")
        .select("id, position, title")
        .eq("study_guide_id", studyGuideId)
        .order("position", { ascending: true });
      if (pieceError) throw pieceError;

      // Progress — create the row on first open so drafts have somewhere to
      // live. Fetched BEFORE piece content so locked (not-yet-reached) pieces
      // never have their theory or `answer_key` requested at all: RLS on a
      // published guide authorizes every piece's row, so gating happens here,
      // client-side, rather than relying on the accordion staying collapsed.
      // The error is checked, not just the data. A discarded failure here reads
      // as "no progress row", which sends `position` to 0 — silently putting the
      // student back on piece 1 with everything re-locked, and (before the check
      // in submitPiece) reporting that as a successful advance.
      const { data: progress, error: progressError } = await supabase
        .from("study_guide_progress")
        .select("current_piece_position, completed_at, draft_answers")
        .eq("user_id", userId)
        .eq("study_guide_id", studyGuideId)
        .eq("offering_id", offeringId)
        .maybeSingle();
      // `maybeSingle` returns data: null / error: null when the row does not
      // exist yet, so this does not break the lazy-insert path just below.
      if (progressError) throw progressError;

      let position = 0;
      let done: string | null = null;
      let draftAnswers: Record<string, unknown> = {};
      if (progress) {
        position = progress.current_piece_position ?? 0;
        done = progress.completed_at ?? null;
        if (
          progress.draft_answers &&
          typeof progress.draft_answers === "object" &&
          !Array.isArray(progress.draft_answers)
        ) {
          draftAnswers = progress.draft_answers as Record<string, unknown>;
        }
      } else {
        // Insert lazily; ignore a duplicate race (another tab created it).
        await supabase.from("study_guide_progress").insert({
          user_id: userId,
          study_guide_id: studyGuideId,
          offering_id: offeringId,
          current_piece_position: 0,
        });
      }
      setCurrentPiecePosition(position);
      setCompletedAt(done);

      // Only the pieces the student has reached (completed + current) get
      // their theory and questions fetched. Anything beyond `position` stays
      // title-only until it unlocks.
      //
      // Of those, only the COMPLETED ones get `answer_key` — the current piece
      // is fetched without it, so the answers to a question the student has not
      // submitted never enter the response (#1011). After a successful submit
      // `load()` re-runs with the advanced position, at which point the
      // just-submitted piece is completed and its key arrives for the reveal.
      const { revealed: revealedPieceIds, unrevealed: unrevealedPieceIds } =
        splitPieceIdsByReveal(pieceRows ?? [], position);
      const unlockedPieceIds = [...revealedPieceIds, ...unrevealedPieceIds];

      const theoryById: Record<string, string | null> = {};
      if (unlockedPieceIds.length > 0) {
        const { data: theoryRows, error: theoryError } = await supabase
          .from("study_guide_pieces")
          .select("id, theory_html")
          .in("id", unlockedPieceIds);
        if (theoryError) throw theoryError;
        for (const row of theoryRows ?? []) theoryById[row.id] = row.theory_html;
      }

      const questionsByPiece: Record<string, LoadedQuestion[]> = {};
      for (const [pieceIds, revealed] of [
        [revealedPieceIds, true],
        [unrevealedPieceIds, false],
      ] as const) {
        if (pieceIds.length === 0) continue;
        const { data: linkRows, error: linkError } = await supabase
          .from("study_guide_piece_questions")
          .select(
            revealed
              ? PIECE_QUESTION_COLUMNS.revealed
              : PIECE_QUESTION_COLUMNS.unrevealed,
          )
          .in("piece_id", pieceIds)
          .order("position", { ascending: true });
        if (linkError) throw linkError;
        for (const row of linkRows ?? []) {
          const r = row as unknown as {
            piece_id: string;
            position: number;
            questions: QuestionRow;
          };
          (questionsByPiece[r.piece_id] ??= []).push(
            toLoadedQuestion(r.questions, r.position, revealed),
          );
        }
      }

      const loadedPieces: LoadedPiece[] = (pieceRows ?? []).map((p) => ({
        id: p.id,
        position: p.position,
        title: p.title,
        theoryHtml: theoryById[p.id] ?? null,
        questions: questionsByPiece[p.id] ?? [],
      }));
      setPieces(loadedPieces);

      // Existing graded answers.
      // Likewise checked: discarding this leaves `answers` empty, so submitted
      // pieces render as though they were never answered.
      const { data: answerRows, error: answersError } = await supabase
        .from("study_guide_answers")
        .select("question_id, piece_id, submission, is_correct, grade, feedback, strengths, areas_for_improvement")
        .eq("user_id", userId)
        .eq("study_guide_id", studyGuideId)
        .eq("offering_id", offeringId);
      if (answersError) throw answersError;

      const answerMap: Record<string, GradedAnswer> = {};
      for (const a of answerRows ?? []) {
        answerMap[a.question_id] = {
          questionId: a.question_id,
          pieceId: a.piece_id,
          submission: a.submission,
          isCorrect: a.is_correct,
          grade: a.grade,
          feedback: a.feedback,
          strengths: a.strengths,
          areasForImprovement: a.areas_for_improvement,
        };
      }
      setAnswers(answerMap);

      // Seed the current piece's draft from any persisted draft, else empty.
      const currentPiece = loadedPieces.find((p) => p.position === position);
      if (currentPiece) {
        const pieceDraft =
          draftAnswers[currentPiece.id] &&
          typeof draftAnswers[currentPiece.id] === "object"
            ? (draftAnswers[currentPiece.id] as Record<string, { submission?: Json }>)
            : {};
        const seeded: Record<string, PlayerAnswer> = {};
        for (const q of currentPiece.questions) {
          const stored = pieceDraft[q.id];
          seeded[q.id] = stored
            ? readPlayerDraft(q, stored as Json, userId)
            : emptyPlayerAnswer(q, userId);
        }
        setDraft(seeded);
        setOpenPieceId(currentPiece.id);
      } else {
        setOpenPieceId("");
      }
      return true;
    } catch (err) {
      console.error("Failed to load study guide", err);
      if (!opts?.quiet) toast.error(t("toast.loadFailed"));
      return false;
    } finally {
      setLoading(false);
    }
  }, [userId, studyGuideId, offeringId, onBack]);

  useEffect(() => {
    void load();
  }, [load]);

  // Flush any pending draft-save timer on unmount.
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  const pieceStates = useMemo(
    () => computePieceStates(pieces, currentPiecePosition),
    [pieces, currentPiecePosition],
  );
  const statusById = useMemo(() => {
    const m = new Map<string, PieceStatus>();
    for (const s of pieceStates) m.set(s.piece.id, s.status);
    return m;
  }, [pieceStates]);

  const completedCount = Math.min(currentPiecePosition, pieces.length);
  const guideComplete = isGuideComplete(pieces, currentPiecePosition) || !!completedAt;

  const currentPiece = pieces.find((p) => p.position === currentPiecePosition) ?? null;

  const persistDraft = useCallback(
    (pieceId: string, nextDraft: Record<string, PlayerAnswer>) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(async () => {
        try {
          const perQuestion: Record<string, Json> = {};
          for (const [qid, ans] of Object.entries(nextDraft)) {
            // `playerDraftEntry`, not `playerSubmission`: a draft has to record
            // whether an ordering answer is a decision or the seeded shuffle,
            // or it comes back as a chosen order on the next load and #1043
            // re-opens across a refresh.
            perQuestion[qid] = playerDraftEntry(ans);
          }
          // Read-modify-write the draft map so other pieces' drafts survive.
          const { data: row } = await supabase
            .from("study_guide_progress")
            .select("draft_answers")
            .eq("user_id", userId)
            .eq("study_guide_id", studyGuideId)
            .eq("offering_id", offeringId)
            .maybeSingle();
          const existing =
            row?.draft_answers && typeof row.draft_answers === "object" && !Array.isArray(row.draft_answers)
              ? (row.draft_answers as Record<string, Json>)
              : {};
          await supabase
            .from("study_guide_progress")
            .update({ draft_answers: { ...existing, [pieceId]: perQuestion } })
            .eq("user_id", userId)
            .eq("study_guide_id", studyGuideId)
            .eq("offering_id", offeringId);
        } catch (err) {
          // A dropped draft is non-fatal — the student can still submit.
          console.warn("Failed to save study guide draft", err);
        }
      }, DRAFT_SAVE_DELAY_MS);
    },
    [userId, studyGuideId, offeringId],
  );

  const updateAnswer = useCallback(
    (questionId: string, next: PlayerAnswer) => {
      if (!currentPiece) return;
      setDraft((prev) => {
        const merged = { ...prev, [questionId]: next };
        persistDraft(currentPiece.id, merged);
        return merged;
      });
    },
    [currentPiece, persistDraft],
  );

  const submitPiece = useCallback(async () => {
    if (!currentPiece || submitting) return;
    if (!pieceSubmitReady(currentPiece.questions, draft)) return;
    // Cancel any pending debounced draft-save so it can't resurrect this
    // piece's draft after the server has cleared it on submit.
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setSubmitting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error(t("toast.notAuthenticated"));

      const payload = {
        studyGuideId,
        offeringId,
        pieceId: currentPiece.id,
        answers: currentPiece.questions.map((q) => ({
          questionId: q.id,
          submission: playerSubmission(draft[q.id] ?? emptyPlayerAnswer(q, userId)),
        })),
      };

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/submit-study-guide-piece`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || json.error) {
        if (json.error === "already_submitted") {
          toast.info(t("toast.alreadySubmitted"));
          await load();
          return;
        }
        if (json.error === "content_blocked") {
          toast.error(t("toast.moderationFlagged"));
          return;
        }
        // `json.message` / `json.error` come from the edge function and are
        // English whatever the locale — server-side output is not localised
        // yet. The fallback at least is.
        throw new Error(json.message || json.error || t("toast.submitRejected"));
      }

      // Fold the returned grades into the answer map so the piece flips to
      // read-only review immediately.
      const results = Array.isArray(json.results) ? json.results : [];
      setAnswers((prev) => {
        const next = { ...prev };
        for (const r of results) {
          const submitted = draft[r.questionId];
          next[r.questionId] = {
            questionId: r.questionId,
            pieceId: currentPiece.id,
            submission: submitted ? playerSubmission(submitted) : null,
            isCorrect: r.isCorrect ?? null,
            grade: r.grade ?? null,
            feedback: r.feedback ?? null,
            strengths: r.strengths ?? null,
            areasForImprovement: r.areasForImprovement ?? null,
          };
        }
        return next;
      });

      // Read from the response before refetching: `load()` replaces the local
      // progress state, so this is the last point at which the just-submitted
      // outcome is known.
      const finished = !!json.progress?.completedAt;

      // Refetch rather than assembling the next piece out of `pieces`.
      //
      // `load()` narrows the content fetch to pieces the student has already
      // reached, so every later piece sits in state as a title with
      // `theoryHtml: null` and `questions: []`. Opening the newly unlocked
      // piece from that state rendered it blank (#1037) — the piece just
      // unlocked is precisely the one whose content was never downloaded.
      //
      // Re-running load() is the fix; widening the ORIGINAL fetch is not. RLS
      // authorizes every piece row of a published guide, so the client keeping
      // its own query narrow is the only thing stopping a student reading ahead
      // to a later piece's `answer_key`. load() re-reads progress, fetches
      // content for the piece now reached, seeds its draft from
      // `draft_answers`, and opens it — all with the same narrowing applied.
      // `quiet`, because this caller has more to say than "could not load":
      // the answers ARE saved either way, and the student needs to know that
      // before they consider redoing the piece.
      const refreshed = await load({ quiet: true });
      if (!refreshed) {
        toast.error(
          t("toast.savedButStale"),
        );
        return;
      }

      toast.success(
        finished
          ? t("toast.guideComplete")
          : t("toast.pieceSubmitted"),
      );
    } catch (err) {
      console.error("Failed to submit piece", err);
      toast.error((err as Error).message || t("toast.submitFailed"));
    } finally {
      setSubmitting(false);
    }
    // `pieces`, `currentPiecePosition` and `completedAt` are deliberately no
    // longer read here — the refetch above is the single source of all three.
  }, [currentPiece, submitting, draft, studyGuideId, offeringId, userId, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-6 h-6 mr-2 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("backToCourse")}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-display font-bold truncate">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {t("progress", { completed: completedCount, count: pieces.length })}
          </p>
        </div>
        {guideComplete && (
          <Badge className="gap-1 bg-green-500/15 text-green-700 border-0">
            <Trophy className="w-3.5 h-3.5" /> {t("complete")}
          </Badge>
        )}
      </div>

      <Progress value={pieces.length > 0 ? (completedCount / pieces.length) * 100 : 0} />

      {pieces.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {t("noPieces")}
          </CardContent>
        </Card>
      ) : (
        <Accordion
          type="single"
          collapsible
          value={openPieceId}
          onValueChange={(v) => {
            // Only allow opening pieces that are unlocked (current or completed).
            if (!v) {
              setOpenPieceId("");
              return;
            }
            const status = statusById.get(v);
            if (status === "locked") return;
            setOpenPieceId(v);
          }}
          className="space-y-2"
        >
          {pieces.map((piece, index) => {
            const status = statusById.get(piece.id) ?? "locked";
            const locked = status === "locked";
            return (
              <AccordionItem
                key={piece.id}
                value={piece.id}
                disabled={locked}
                className={`border rounded-md px-3 ${locked ? "opacity-60" : ""}`}
                data-testid={`sg-player-piece-${piece.id}`}
              >
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-2 text-left">
                    <Badge variant="outline">{index + 1}</Badge>
                    <span className="font-medium">{piece.title}</span>
                    {status === "completed" && (
                      <Badge variant="secondary" className="gap-1 bg-green-500/15 text-green-700 border-0">
                        <CheckCircle2 className="w-3 h-3" /> {t("piece.done")}
                      </Badge>
                    )}
                    {status === "current" && (
                      <Badge variant="outline">{t("piece.inProgress")}</Badge>
                    )}
                    {locked && (
                      <Badge variant="outline" className="gap-1 text-muted-foreground">
                        <Lock className="w-3 h-3" /> {t("piece.locked")}
                      </Badge>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  {!locked && (
                    <PieceView
                      piece={piece}
                      status={status}
                      answers={answers}
                      draft={draft}
                      submitting={submitting}
                      userId={userId}
                      onAnswerChange={updateAnswer}
                      onSubmit={submitPiece}
                    />
                  )}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}
    </div>
  );
}

function TheoryBlock({ html }: { html: string | null }) {
  const { t } = useTranslation("studyGuide");
  if (!html || html.replace(/<[^>]+>/g, "").trim().length === 0) {
    return null;
  }
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium text-muted-foreground">
        <BookOpen className="w-4 h-4" /> {t("theory")}
        {/* Written by `generate-study-guide-theory`, then editable in place
            through StudyGuidePieceEditor. `theory_updated_at` is bumped by a
            trigger on any change, so it cannot tell the two apart (#936). */}
        <AiDisclaimer variant="tooltip" source="model-or-teacher" className="ml-1" />
      </div>
      {/* Instructor/AI-authored HTML. This used to sanitize only, on the
          assumption the maths arrived as MathML — but the theory prompt asks
          for LaTeX with `$` delimiters, so students were reading raw
          `$f'(\xi)=0$`. renderAuthoredHtml runs the KaTeX pass first. */}
      <div
        className="prose prose-sm dark:prose-invert max-w-none"
        dangerouslySetInnerHTML={{ __html: renderAuthoredHtml(html) }}
      />
    </div>
  );
}

function PieceView({
  piece,
  status,
  answers,
  draft,
  submitting,
  userId,
  onAnswerChange,
  onSubmit,
}: {
  piece: LoadedPiece;
  status: PieceStatus;
  answers: Record<string, GradedAnswer>;
  draft: Record<string, PlayerAnswer>;
  submitting: boolean;
  userId: string;
  onAnswerChange: (questionId: string, next: PlayerAnswer) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("studyGuide");
  const reviewing = status === "completed";
  const unanswered = reviewing ? [] : unansweredQuestionIds(piece.questions, draft);
  const ready = pieceSubmitReady(piece.questions, draft);

  return (
    <div className="space-y-5 pt-2">
      <TheoryBlock html={piece.theoryHtml} />

      <ol className="space-y-5">
        {piece.questions.map((q, idx) => {
          const graded = answers[q.id];
          // In review mode reconstruct the submitted answer; otherwise the live draft.
          const answer: PlayerAnswer = reviewing
            ? readPlayerAnswer(q, { submission: graded?.submission ?? null }, userId)
            : draft[q.id] ?? emptyPlayerAnswer(q, userId);
          return (
            <li key={q.id} className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-muted-foreground tabular-nums">{idx + 1}.</span>
                {q.type !== "fill_gaps" && (
                  <div
                    className="text-base font-medium leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: processLatexContent(q.question) }}
                  />
                )}
              </div>
              {q.diagram?.source && (
                <QuestionDiagram source={q.diagram.source} alt={q.diagram.alt ?? null} />
              )}
              <AnswerField
                question={q}
                answer={answer}
                reveal={reviewing}
                disabled={reviewing || submitting}
                userId={userId}
                onChange={(next) => onAnswerChange(q.id, next)}
              />
              {reviewing && graded && <Feedback graded={graded} type={q.type} />}
            </li>
          );
        })}
      </ol>

      {!reviewing && (
        <div className="space-y-2 border-t pt-4">
          {unanswered.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("piece.unanswered", { count: unanswered.length })}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={onSubmit} disabled={!ready || submitting} className="gap-2">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {submitting ? t("piece.submitting") : t("piece.submit")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AnswerField({
  question: q,
  answer,
  reveal,
  disabled,
  userId,
  onChange,
}: {
  question: LoadedQuestion;
  answer: PlayerAnswer;
  reveal: boolean;
  disabled: boolean;
  userId: string;
  onChange: (next: PlayerAnswer) => void;
}) {
  switch (q.type) {
    case "mcq": {
      const selected = answer.kind === "mcq" ? answer.selected : [];
      return (
        <McqField
          options={q.options}
          correctIndices={q.correctIndices}
          value={selected}
          onToggle={(index) => {
            const set = new Set(selected);
            if (set.has(index)) set.delete(index);
            else set.add(index);
            onChange({ kind: "mcq", selected: [...set].sort((a, b) => a - b) });
          }}
          disabled={disabled}
          reveal={reveal}
        />
      );
    }
    case "open":
      return (
        <OpenField
          value={answer.kind === "open" ? answer.text : ""}
          onChange={(text) => onChange({ kind: "open", text })}
          disabled={disabled}
          reveal={reveal}
        />
      );
    case "fill_gaps": {
      const inputs = answer.kind === "fill_gaps" ? answer.inputs : [];
      return (
        <FillGapsField
          stem={q.fillGapsStem}
          gaps={q.fillGapsGaps}
          value={inputs}
          onChange={(index, value) => {
            const next = [...inputs];
            next[index] = value;
            onChange({ kind: "fill_gaps", inputs: next });
          }}
          disabled={disabled}
          reveal={reveal}
        />
      );
    }
    case "ordering":
      return (
        <OrderingField
          value={answer.kind === "ordering" ? answer.order : []}
          canonical={q.orderingItems}
          // Any emission — a drag or the "Keep this order" confirm — is the
          // student settling on an order, which is what the submit gate wants
          // to see before counting the question as answered (#1043).
          onChange={(order) => onChange({ kind: "ordering", order, touched: true })}
          disabled={disabled}
          reveal={reveal}
          needsConfirm={answer.kind === "ordering" && !answer.touched}
        />
      );
    case "classification":
      return (
        <ClassificationField
          questionId={q.id}
          categories={q.categories}
          items={q.items}
          assignments={q.classificationAssignments}
          userId={userId}
          value={answer.kind === "classification" ? answer.placements : {}}
          onSelect={(itemId, categoryId) => {
            const placements =
              answer.kind === "classification" ? { ...answer.placements } : {};
            placements[itemId] = categoryId;
            onChange({ kind: "classification", placements });
          }}
          disabled={disabled}
          reveal={reveal}
        />
      );
    default:
      return null;
  }
}

function Feedback({ graded, type }: { graded: GradedAnswer; type: QuestionType }) {
  const { t } = useTranslation("studyGuide");
  const hasCorrectness = graded.isCorrect !== null;
  return (
    <div className="rounded-lg border bg-muted/40 p-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {hasCorrectness ? (
          graded.isCorrect ? (
            <Badge className="bg-green-500/15 text-green-700 border-0">
              {t("feedback.correct")}
            </Badge>
          ) : (
            <Badge className="bg-red-500/15 text-red-700 border-0">
              {t("feedback.incorrect")}
            </Badge>
          )
        ) : typeof graded.grade === "number" ? (
          <Badge variant="outline">{t("feedback.grade", { grade: graded.grade })}</Badge>
        ) : (
          // An open answer with neither verdict nor grade is awaiting the
          // instructor's review — recorded, never auto-scored.
          <Badge variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/20">
            {t("feedback.pendingReview")}
          </Badge>
        )}
      </div>
      {/*
        Every one of these is the grader's prose about a maths answer, so it
        carries LaTeX as routinely as the question does. They were printed as
        plain text while the `type !== "open"` branch below rendered the very
        same `graded.feedback` — and open questions are the free-response ones,
        so the branch that most needed rendering was the one without it.
      */}
      {graded.feedback && type === "open" && (
        <div dangerouslySetInnerHTML={{ __html: processLatexContent(graded.feedback) }} />
      )}
      {graded.strengths && graded.strengths.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("feedback.strengths")}</p>
          <ul className="list-disc list-inside">
            {graded.strengths.map((s, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: processLatexContent(s) }} />
            ))}
          </ul>
        </div>
      )}
      {graded.areasForImprovement && graded.areasForImprovement.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t("feedback.areasForImprovement")}
          </p>
          <ul className="list-disc list-inside">
            {graded.areasForImprovement.map((s, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: processLatexContent(s) }} />
            ))}
          </ul>
        </div>
      )}
      {graded.feedback && type !== "open" && (
        <div
          className="text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: processLatexContent(graded.feedback) }}
        />
      )}
      {/*
        Three cases, and only two of them warrant a notice (#936).

        An open answer's grade and feedback are the instructor's (the AI no
        longer grades; legacy rows may still carry model output from the
        retired grader) — pending ones show nothing generated at all.

        Every other type is marked by `submit-study-guide-piece` in plain code,
        and the text shown as feedback is the question's own `explanation`,
        which the piece editor lets an instructor rewrite. The machine did not
        write the verdict, and may not have written the words either.

        And a non-open answer with no explanation shows a bare Correct/Incorrect
        badge decided by `gradeMcq` and friends. There is no model output on
        screen at all, so there is nothing to disclose.
      */}
      {graded.feedback && (
        <AiDisclaimer
          variant="compact"
          source="model-or-teacher"
          // Only the open answer carries a score at all, and it is the
          // instructor's decision; the formative-use sentence still applies
          // to it. Deterministic types are marked by `gradeMcq` and friends
          // in plain code.
          assessment={type === "open"}
        />
      )}
    </div>
  );
}

export default StudyGuidePlayer;
