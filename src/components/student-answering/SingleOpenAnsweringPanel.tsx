import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, Send, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatQuestionText } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { AiDisclaimer } from "@/components/AiDisclaimer";
import {
  openAnsweringModeFromPayload,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import { AnsweringChrome } from "./AnsweringChrome";
import type { SinglePanelProps } from "./types";

interface LoadedQuestion {
  id: string;
  question: string;
  difficulty: string;
  diagram?: { source: string; alt?: string } | null;
}

interface SingleAnswerGrade {
  /** NULL until the instructor grades the submission (pending review). */
  grade: number | null;
  feedback: string;
  strengths: string[];
  areasForImprovement: string[];
  submittedAnswer: string;
}

const SOFT_CHAR_HINT = 1500;

/**
 * Embeddable single-question open-answer panel (#755). Only handles the
 * `single` answering mode — one textarea, one submit; the answer is recorded
 * by `submit-open-answer` and held for instructor review (the AI never
 * grades). Socratic / interactive mode is intentionally NOT
 * covered here: it stays inside `StudentOpenQuestions` because its UX is
 * inherently multi-turn and not "one question by id" in the same sense.
 *
 * The unified Practice surface (#754) only surfaces `single`-mode open
 * questions anyway (see `useStudentPracticeQuestions` filter at #753).
 */
export function SingleOpenAnsweringPanel({
  questionId,
  courseId,
  onBack,
  onCompleted,
  onStatusChange,
}: SinglePanelProps) {
  const { t } = useTranslation("practice");
  const [question, setQuestion] = useState<LoadedQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [grade, setGrade] = useState<SingleAnswerGrade | null>(null);
  const [flagged, setFlagged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const { data: row, error } = await supabase
          .from("questions")
          .select("id, question, payload, difficulty, hidden, type")
          .eq("id", questionId)
          .eq("type", "open")
          .maybeSingle();
        if (error) throw error;
        if (cancelled) return;
        if (!row) {
          toast.error(t("toast.questionNotFound"));
          return;
        }

        const mode = openAnsweringModeFromPayload(row.payload ?? null);
        if (mode !== "single") {
          setUnsupported(true);
          return;
        }

        const loaded: LoadedQuestion = {
          id: row.id,
          question: row.question ?? "",
          difficulty: row.difficulty,
          diagram: questionDiagramFromPayload(row.payload ?? null),
        };

        const { data: existing } = await supabase
          .from("open_question_grades")
          .select("grade, feedback, strengths, areas_for_improvement, submitted_answer")
          .eq("open_question_id", questionId)
          .eq("user_id", user.id)
          .maybeSingle();

        if (cancelled) return;
        setQuestion(loaded);

        if (existing) {
          setGrade({
            grade: existing.grade ?? null,
            feedback: existing.feedback ?? "",
            strengths: existing.strengths ?? [],
            areasForImprovement: existing.areas_for_improvement ?? [],
            submittedAnswer: existing.submitted_answer ?? "",
          });
          onStatusChange?.("completed");
        } else {
          onStatusChange?.("not_started");
        }
      } catch (err: any) {
        console.error("Failed to load open question:", err);
        toast.error(t("toast.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  const handleSubmit = async () => {
    if (!question || submitting) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error(t("open.writeBeforeSubmitting"));
      return;
    }

    setSubmitting(true);
    onStatusChange?.("in_progress");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error(t("toast.notAuthenticated"));
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/submit-open-answer`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          questionId: question.id,
          courseId,
          studentAnswer: trimmed,
        }),
      });
      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || json.error) {
        if (json.error === "already_submitted") {
          toast.info(json.message || t("toast.alreadySubmitted"));
          setSubmitting(false);
          onStatusChange?.("completed");
          onCompleted?.();
          return;
        }
        if (json.error === "content_blocked") {
          toast.error(json.message || t("toast.moderationFlagged"));
          setFlagged(true);
          onStatusChange?.("in_progress");
          return;
        }
        throw new Error(json.message || json.error || t("toast.submitFailed"));
      }

      // Recorded and pending instructor review — no grade or feedback yet.
      setGrade({
        grade: null,
        feedback: "",
        strengths: [],
        areasForImprovement: [],
        submittedAnswer: trimmed,
      });
      onStatusChange?.("completed");
      onCompleted?.();
      toast.success(t("open.answerSubmitted"), { duration: 3000 });
    } catch (err: any) {
      console.error("Open-answer submit error:", err);
      toast.error(err?.message || t("toast.submitFailed"));
      onStatusChange?.("in_progress");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (unsupported) {
    return (
      <div className="flex flex-col gap-4">
        <AnsweringChrome title={t("open.openQuestionTitle")} onBack={onBack} />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("open.socraticNotice")}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!question) {
    return (
      <div className="flex flex-col gap-4">
        <AnsweringChrome title={t("open.openQuestionTitle")} onBack={onBack} />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("chrome.unavailable")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const submittedView = grade !== null;
  const draftLength = draft.length;

  return (
    <div className="flex flex-col gap-4">
      <AnsweringChrome
        title={t("open.title")}
        subtitle={t("open.subtitle")}
        difficulty={question.difficulty}
        onBack={onBack}
      />

      <Card>
        <CardContent className="p-4">
          {question.diagram?.source && (
            <QuestionDiagram
              source={question.diagram.source}
              alt={question.diagram.alt ?? null}
            />
          )}
          <div className="flex items-start gap-3">
            <BookOpen className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
            <div
              className="text-sm text-foreground prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: formatQuestionText(question.question) }}
            />
          </div>
        </CardContent>
      </Card>

      {submittedView ? (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <span className="font-medium">{t("shared.submitted")}</span>
            </div>
            {/* Practice is formative: the numeric grade stays server-side and
                only the qualitative feedback is shown. An answer with no
                feedback yet is pending the instructor's review; feedback,
                once present, was written or adopted by the instructor. */}
            {grade!.feedback || grade!.strengths.length > 0 ? (
              <AiDisclaimer source="model-or-teacher" assessment />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("open.pendingReviewNote")}
              </p>
            )}
            <div>
              <Label className="text-muted-foreground text-xs">{t("shared.yourAnswer")}</Label>
              <div className="mt-1 p-3 bg-muted rounded-md text-sm whitespace-pre-wrap">
                {grade!.submittedAnswer || t("open.answerUnavailable")}
              </div>
            </div>
            {grade!.feedback && (
              <div>
                <Label className="text-muted-foreground text-xs">{t("shared.feedback")}</Label>
                <div className="mt-1 p-3 bg-muted rounded-md text-sm">{grade!.feedback}</div>
              </div>
            )}
            {grade!.strengths.length > 0 && (
              <div>
                <Label className="text-muted-foreground text-xs">{t("shared.strengths")}</Label>
                <ul className="mt-1 list-disc list-inside text-sm space-y-1">
                  {grade!.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {grade!.areasForImprovement.length > 0 && (
              <div>
                <Label className="text-muted-foreground text-xs">
                {t("open.areasForImprovement")}
              </Label>
                <ul className="mt-1 list-disc list-inside text-sm space-y-1">
                  {grade!.areasForImprovement.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground italic">
              {t("open.oneSubmissionNote")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label htmlFor="single-open-answer-textarea" className="text-sm font-medium">
              {t("shared.yourAnswer")}
            </Label>
            <Textarea
              id="single-open-answer-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("open.placeholder")}
              rows={8}
              disabled={submitting || flagged}
              className="resize-y"
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className={draftLength > SOFT_CHAR_HINT ? "text-amber-600" : undefined}>
                {t("open.characterCount", { count: draftLength })}
                {draftLength > SOFT_CHAR_HINT ? t("open.beMoreConcise") : ""}
              </span>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || flagged || draftLength === 0}
                className="gap-2"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                {submitting ? t("shared.submitting") : t("shared.submit")}
              </Button>
            </div>
            {flagged && (
              <p className="text-xs text-destructive">
                {t("open.moderationBlocked")}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default SingleOpenAnsweringPanel;
